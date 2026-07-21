const http = require("http");
const { WebSocketServer } = require("ws");
const webpush = require("web-push");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");

const PORT = process.env.PORT || 8080;

// ---- DATABASE (accounts) ----
const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

async function initDb() {
  if (!pool) { console.log("No DATABASE_URL set - accounts disabled."); return; }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS accounts (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      pass_hash TEXT NOT NULL,
      token TEXT,
      data JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log("Accounts table ready.");
}
initDb().catch((e) => console.error("DB init error:", e.message));

function newToken() { return crypto.randomBytes(24).toString("hex"); }

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => { raw += c; if (raw.length > 2e6) req.destroy(); });
    req.on("end", () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}
function sendJson(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}
function cleanUser(u) { return String(u || "").trim().toLowerCase(); }

// ---- WEB PUSH SETUP ----
const VAPID_PUBLIC  = "BMXx6cuEimnH25ls50WM7ygSCw-XEqROlfPjl_l3ithPw_usOL0Qqkz8koRcnOknFOwy4rQu7pfi3Vro7busBwE";
const VAPID_PRIVATE = process.env.VAPID_PRIVATE || "41-pg36cweRhuSt6F0b5cxQuWfNlsgz7FXyX2mWXKus";
webpush.setVapidDetails("mailto:applingluke322@gmail.com", VAPID_PUBLIC, VAPID_PRIVATE);

// In-memory list of push subscriptions (resets when server restarts).
const pushSubs = new Map(); // endpoint -> subscription object

function sendPushToAll(payload) {
  const body = JSON.stringify(payload);
  for (const [endpoint, sub] of pushSubs) {
    webpush.sendNotification(sub, body).catch((err) => {
      // 404/410 mean the subscription is dead - drop it
      if (err && (err.statusCode === 404 || err.statusCode === 410)) {
        pushSubs.delete(endpoint);
      }
    });
  }
}

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

const server = http.createServer((req, res) => {
  cors(res);

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // Save a player's notification subscription
  if (req.method === "POST" && req.url === "/subscribe") {
    let raw = "";
    req.on("data", (c) => { raw += c; if (raw.length > 1e5) req.destroy(); });
    req.on("end", () => {
      try {
        const sub = JSON.parse(raw);
        if (sub && sub.endpoint) {
          pushSubs.set(sub.endpoint, sub);
          console.log("Push subscribed. Total subs: " + pushSubs.size);
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400); res.end("bad json");
      }
    });
    return;
  }

  // Fire a test notification to everyone (open this URL in a browser to test)
  if (req.method === "GET" && req.url === "/test-push") {
    sendPushToAll({ title: "Chaos Cidy", body: "Test notification works! \uD83C\uDF89", url: "https://chaoscidy1.netlify.app" });
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Sent test push to " + pushSubs.size + " subscriber(s).\n");
    return;
  }

  // ---- ACCOUNT ENDPOINTS ----
  if (req.method === "POST" && req.url === "/signup") {
    (async () => {
      if (!pool) return sendJson(res, 500, { error: "Accounts not set up yet." });
      try {
        const b = await readBody(req);
        const username = cleanUser(b.username);
        const password = String(b.password || "");
        if (username.length < 3 || username.length > 20 || !/^[a-z0-9_]+$/.test(username))
          return sendJson(res, 400, { error: "Username must be 3-20 letters, numbers, or underscores." });
        if (password.length < 4)
          return sendJson(res, 400, { error: "Password must be at least 4 characters." });
        const exists = await pool.query("SELECT 1 FROM accounts WHERE username=$1", [username]);
        if (exists.rowCount > 0) return sendJson(res, 409, { error: "That username is taken." });
        const hash = await bcrypt.hash(password, 10);
        const token = newToken();
        await pool.query("INSERT INTO accounts (username, pass_hash, token) VALUES ($1,$2,$3)", [username, hash, token]);
        return sendJson(res, 200, { ok: true, username, token, data: {} });
      } catch (e) { return sendJson(res, 500, { error: "Server error: " + e.message }); }
    })();
    return;
  }

  if (req.method === "POST" && req.url === "/login") {
    (async () => {
      if (!pool) return sendJson(res, 500, { error: "Accounts not set up yet." });
      try {
        const b = await readBody(req);
        const username = cleanUser(b.username);
        const password = String(b.password || "");
        const r = await pool.query("SELECT * FROM accounts WHERE username=$1", [username]);
        if (r.rowCount === 0) return sendJson(res, 401, { error: "No account with that username." });
        const acc = r.rows[0];
        const ok = await bcrypt.compare(password, acc.pass_hash);
        if (!ok) return sendJson(res, 401, { error: "Wrong password." });
        const token = newToken();
        await pool.query("UPDATE accounts SET token=$1 WHERE id=$2", [token, acc.id]);
        return sendJson(res, 200, { ok: true, username, token, data: acc.data || {} });
      } catch (e) { return sendJson(res, 500, { error: "Server error: " + e.message }); }
    })();
    return;
  }

  if (req.method === "POST" && req.url === "/save") {
    (async () => {
      if (!pool) return sendJson(res, 500, { error: "Accounts not set up yet." });
      try {
        const b = await readBody(req);
        const token = String(b.token || "");
        if (!token) return sendJson(res, 401, { error: "Not logged in." });
        const r = await pool.query("UPDATE accounts SET data=$1 WHERE token=$2 RETURNING username", [b.data || {}, token]);
        if (r.rowCount === 0) return sendJson(res, 401, { error: "Session expired - log in again." });
        return sendJson(res, 200, { ok: true });
      } catch (e) { return sendJson(res, 500, { error: "Server error: " + e.message }); }
    })();
    return;
  }

  if (req.method === "POST" && req.url === "/loaddata") {
    (async () => {
      if (!pool) return sendJson(res, 500, { error: "Accounts not set up yet." });
      try {
        const b = await readBody(req);
        const token = String(b.token || "");
        if (!token) return sendJson(res, 401, { error: "Not logged in." });
        const r = await pool.query("SELECT username, data FROM accounts WHERE token=$1", [token]);
        if (r.rowCount === 0) return sendJson(res, 401, { error: "Session expired - log in again." });
        return sendJson(res, 200, { ok: true, username: r.rows[0].username, data: r.rows[0].data || {} });
      } catch (e) { return sendJson(res, 500, { error: "Server error: " + e.message }); }
    })();
    return;
  }

  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Chaos City multiplayer server is running.\n");
});

const wss = new WebSocketServer({ server });

const players = new Map();
let nextId = 1;

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) {
    try { ws.send(JSON.stringify(obj)); } catch (e) {}
  }
}

function broadcast(obj, exceptId) {
  const msg = JSON.stringify(obj);
  for (const [id, p] of players) {
    if (id === exceptId) continue;
    if (p.ws.readyState === p.ws.OPEN) {
      try { p.ws.send(msg); } catch (e) {}
    }
  }
}

wss.on("connection", (ws) => {
  const id = nextId++;
  players.set(id, {
    ws,
    state: { id, name: "player" + id, x: 0, z: 0, a: 0, inCar: false, mode: "" }
  });

  console.log("Player " + id + " connected. Total: " + players.size);

  const others = [];
  for (const [oid, p] of players) {
    if (oid !== id) others.push(p.state);
  }
  send(ws, { type: "welcome", id, players: others });
  broadcast({ type: "join", player: players.get(id).state }, id);

  // Notify everyone's phone that a player joined (only if 2+ players)
  if (players.size >= 2) {
    sendPushToAll({
      title: "Chaos Cidy",
      body: "A player just joined! " + players.size + " players online \uD83C\uDFAE",
      url: "https://chaoscidy1.netlify.app"
    });
  }

  ws.on("message", (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch (e) { return; }

    if (data.type === "state") {
      const p = players.get(id);
      if (!p) return;
      p.state = {
        id,
        name: (data.name || p.state.name).slice(0, 16),
        x: +data.x || 0,
        z: +data.z || 0,
        a: +data.a || 0,
        inCar: !!data.inCar,
        mode: (data.mode || "").slice(0, 16)
      };
      broadcast({ type: "state", player: p.state }, id);
    } else if (data.type === "chat") {
      const p = players.get(id);
      const text = ("" + (data.text || "")).slice(0, 120);
      if (text) broadcast({ type: "chat", id, name: p.state.name, text }, -1);
    }
  });

  ws.on("close", () => {
    players.delete(id);
    broadcast({ type: "leave", id }, id);
    console.log("Player " + id + " left. Total: " + players.size);
  });

  ws.on("error", () => {});
});

server.listen(PORT, () => {
  console.log("Chaos City server listening on port " + PORT);
});
