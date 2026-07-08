const http = require("http");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8080;

const server = http.createServer((req, res) => {
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
