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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bans (
      id SERIAL PRIMARY KEY,
      kind TEXT NOT NULL,          -- 'device' or 'account'
      value TEXT NOT NULL,
      reason TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(kind, value)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS feedback (
      id SERIAL PRIMARY KEY,
      message TEXT NOT NULL,
      username TEXT DEFAULT '',
      device TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log("Accounts + bans + feedback tables ready.");
}
initDb().catch((e) => console.error("DB init error:", e.message));

const ADMIN_SECRET = process.env.ADMIN_SECRET || "change-me-please";

async function isBanned(deviceId, username){
  if(!pool) return null;
  try{
    const vals=[]; const parts=[];
    if(deviceId){ parts.push("(kind='device' AND value=$"+(vals.length+1)+")"); vals.push(String(deviceId)); }
    if(username){ parts.push("(kind='account' AND value=$"+(vals.length+1)+")"); vals.push(String(username).toLowerCase()); }
    if(!parts.length) return null;
    const r=await pool.query("SELECT kind, reason FROM bans WHERE "+parts.join(" OR ")+" LIMIT 1", vals);
    return r.rowCount>0 ? r.rows[0] : null;
  }catch(e){ return null; }
}

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

  // ---- ADMIN BAN ENDPOINTS (protected by ADMIN_SECRET) ----
  if (req.method === "POST" && (req.url === "/admin/ban" || req.url === "/admin/unban" || req.url === "/admin/bans")) {
    (async () => {
      if (!pool) return sendJson(res, 500, { error: "DB not set up." });
      try {
        const b = await readBody(req);
        if (String(b.secret||"") !== ADMIN_SECRET) return sendJson(res, 403, { error: "Wrong admin password." });

        if (req.url === "/admin/bans") {
          const r = await pool.query("SELECT kind, value, reason, created_at FROM bans ORDER BY created_at DESC LIMIT 200");
          return sendJson(res, 200, { ok: true, bans: r.rows });
        }
        const kind = (b.kind === "account") ? "account" : "device";
        let value = String(b.value||"").trim();
        if (kind === "account") value = value.toLowerCase();
        if (!value) return sendJson(res, 400, { error: "Nothing to " + (req.url==='/admin/ban'?'ban':'unban') + "." });

        if (req.url === "/admin/ban") {
          await pool.query(
            "INSERT INTO bans (kind, value, reason) VALUES ($1,$2,$3) ON CONFLICT (kind, value) DO UPDATE SET reason=$3",
            [kind, value, String(b.reason||"")]
          );
          // kick any currently-connected matching players
          for (const [pid, p] of players) {
            if ((kind==='device' && p.deviceId===value) || (kind==='account' && (p.username||'').toLowerCase()===value)) {
              try { send(p.ws, { type: "banned", reason: b.reason || "You have been banned." }); p.ws.close(); } catch(e){}
            }
          }
          return sendJson(res, 200, { ok: true, banned: { kind, value } });
        } else {
          await pool.query("DELETE FROM bans WHERE kind=$1 AND value=$2", [kind, value]);
          return sendJson(res, 200, { ok: true, unbanned: { kind, value } });
        }
      } catch (e) { return sendJson(res, 500, { error: "Server error: " + e.message }); }
    })();
    return;
  }

  // ---- FEEDBACK: players submit (no login needed) ----
  if (req.method === "POST" && req.url === "/feedback") {
    (async () => {
      if (!pool) return sendJson(res, 500, { error: "Not set up." });
      try {
        const b = await readBody(req);
        const message = String(b.message || "").trim().slice(0, 1000);
        if (message.length < 2) return sendJson(res, 400, { error: "Message too short." });
        const username = String(b.username || "").slice(0, 40);
        const device = String(b.device || "").slice(0, 80);
        await pool.query("INSERT INTO feedback (message, username, device) VALUES ($1,$2,$3)", [message, username, device]);
        return sendJson(res, 200, { ok: true });
      } catch (e) { return sendJson(res, 500, { error: "Server error: " + e.message }); }
    })();
    return;
  }

  // ---- ADMIN: view / clear feedback (protected) ----
  if (req.method === "POST" && (req.url === "/admin/feedback" || req.url === "/admin/feedback-clear")) {
    (async () => {
      if (!pool) return sendJson(res, 500, { error: "DB not set up." });
      try {
        const b = await readBody(req);
        if (String(b.secret || "") !== ADMIN_SECRET) return sendJson(res, 403, { error: "Wrong admin password." });
        if (req.url === "/admin/feedback-clear") {
          await pool.query("DELETE FROM feedback");
          return sendJson(res, 200, { ok: true, cleared: true });
        }
        const r = await pool.query("SELECT message, username, device, created_at FROM feedback ORDER BY created_at DESC LIMIT 200");
        return sendJson(res, 200, { ok: true, feedback: r.rows });
      } catch (e) { return sendJson(res, 500, { error: "Server error: " + e.message }); }
    })();
    return;
  }

  // ---- ADMIN: list who's currently online (to spot spammers/guests) ----
  if (req.method === "POST" && req.url === "/admin/online") {
    (async () => {
      try {
        const b = await readBody(req);
        if (String(b.secret || "") !== ADMIN_SECRET) return sendJson(res, 403, { error: "Wrong admin password." });
        const list = [];
        for (const [pid, p] of players) {
          list.push({
            name: (p.state && p.state.name) || "guest",
            device: p.deviceId || "",
            account: p.username || "",
            muted: (p.mutedUntil && Date.now() < p.mutedUntil) || false
          });
        }
        return sendJson(res, 200, { ok: true, count: list.length, players: list });
      } catch (e) { return sendJson(res, 500, { error: "Server error: " + e.message }); }
    })();
    return;
  }

  // ---- LEADERBOARD (public - top players by money & level) ----
  if (req.method === "GET" && req.url.startsWith("/leaderboard")) {
    (async () => {
      if (!pool) return sendJson(res, 500, { error: "Not set up." });
      try {
        // pull money & level out of the saved JSON data for each account
        const r = await pool.query(`
          SELECT username,
                 COALESCE((data->>'money')::bigint, 0)  AS money,
                 COALESCE((data->>'level')::int, 1)      AS level
          FROM accounts
          WHERE data IS NOT NULL
          ORDER BY money DESC
          LIMIT 20
        `);
        const byMoney = r.rows.map(x => ({ username: x.username, money: Number(x.money), level: x.level }));
        const r2 = await pool.query(`
          SELECT username,
                 COALESCE((data->>'level')::int, 1)      AS level,
                 COALESCE((data->>'money')::bigint, 0)   AS money
          FROM accounts
          WHERE data IS NOT NULL
          ORDER BY level DESC, money DESC
          LIMIT 20
        `);
        const byLevel = r2.rows.map(x => ({ username: x.username, level: x.level, money: Number(x.money) }));
        return sendJson(res, 200, { ok: true, byMoney, byLevel });
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

wss.on("connection", (ws, req) => {
  const id = nextId++;

  // parse device id + username from the connection URL for ban enforcement
  let deviceId = "", username = "";
  try {
    const u = new URL(req.url, "http://x");
    deviceId = u.searchParams.get("d") || "";
    username = (u.searchParams.get("u") || "").toLowerCase();
  } catch (e) {}

  // check bans, then allow or reject
  (async () => {
    const ban = await isBanned(deviceId, username);
    if (ban) {
      try { send(ws, { type: "banned", reason: ban.reason || "You have been banned from Chaos Cidy." }); ws.close(); } catch(e){}
      return;
    }
    admitPlayer();
  })();

  function admitPlayer(){
  players.set(id, {
    ws, deviceId, username,
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
      if (!p) return;

      // ---- ANTI-SPAM PROTECTION ----
      const now = Date.now();
      p.chatHist = p.chatHist || [];
      p.mutedUntil = p.mutedUntil || 0;

      // if currently muted for spamming, silently drop
      if (now < p.mutedUntil) return;

      // 1) cooldown: min 800ms between messages
      if (p.lastChat && now - p.lastChat < 800) {
        p.spamStrikes = (p.spamStrikes || 0) + 1;
        if (p.spamStrikes >= 4) { p.mutedUntil = now + 15000; try{ p.ws.send(JSON.stringify({type:"chat",id:-1,name:"SYSTEM",text:"You're muted 15s for spamming. Slow down!"})); }catch(e){} }
        return;
      }

      // 2) rate cap: max 5 messages per 10 seconds
      p.chatHist = p.chatHist.filter(t => now - t < 10000);
      if (p.chatHist.length >= 5) {
        p.mutedUntil = now + 15000;
        try{ p.ws.send(JSON.stringify({type:"chat",id:-1,name:"SYSTEM",text:"Too many messages — muted 15s."})); }catch(e){}
        return;
      }

      let text = ("" + (data.text || "")).slice(0, 120).trim();
      if (!text) return;

      // 3) block exact repeats (copy-paste spam)
      if (p.lastText && text.toLowerCase() === p.lastText.toLowerCase()) {
        p.repeatCount = (p.repeatCount || 0) + 1;
        if (p.repeatCount >= 2) { p.mutedUntil = now + 10000; return; }
      } else { p.repeatCount = 0; }

      // 4) squash walls of the same character (aaaaaa, !!!!!!)
      text = text.replace(/(.)\1{9,}/g, "$1$1$1");

      p.lastChat = now; p.lastText = text; p.chatHist.push(now); p.spamStrikes = 0;
      broadcast({ type: "chat", id, name: p.state.name, text }, -1);
    }
  });

  ws.on("close", () => {
    players.delete(id);
    broadcast({ type: "leave", id }, id);
    console.log("Player " + id + " left. Total: " + players.size);
  });

  ws.on("error", () => {});
  } // end admitPlayer
});

server.listen(PORT, () => {
  console.log("Chaos City server listening on port " + PORT);
});
