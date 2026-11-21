
const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  maxHttpBufferSize: 500000,
  perMessageDeflate: false,
  pingInterval: 25000,
  pingTimeout: 20000
});

app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (_req, res) => {
  res.json({ ok: true, game: "CAR CLASH", mode: "LIGHT" });
});

const players = new Map();

const W = 1200;
const FLOOR = 500;

const FPS = 20;
const BROADCAST_INTERVAL = 2;

const BOT_NAMES = [
  "TURBO CAT",
  "CITY RACER",
  "PON PON",
  "BLUE COMET",
  "MOMO DRIVE",
  "NIGHT TAXI"
];

const COLORS = [
  "#f5b84a",
  "#63c8dc",
  "#ef8b91",
  "#9ed17b"
];

let tick = 0;
let matchEnded = false;
let endTimer = null;

function makePlayer(id, data = {}, human = true) {
  return {
    id,
    name: String(data.name || "PLAYER").slice(0, 16),

    car:
      typeof data.car === "string" &&
      data.car.startsWith("data:image/") &&
      data.car.length < 180000
        ? data.car
        : "",

    human,

    x: 150 + Math.random() * 900,
    y: FLOOR - 36,

    vx: 0,
    vy: 0,

    facing: Math.random() < 0.5 ? -1 : 1,

    alive: true,
    color: COLORS[Math.floor(Math.random() * COLORS.length)],

    input: {
      left: false,
      right: false,
      jump: false,
      boost: false
    },

    onGround: true,
    hitCooldown: 0,
    jumpLock: false
  };
}

function humans() {
  return [...players.values()].filter(p => p.human);
}

function bots() {
  return [...players.values()].filter(p => !p.human);
}

// CPUは1人のときだけ3台
function syncBots() {
  const hs = humans();

  if (hs.length === 1) {
    if (bots().length === 3) return;

    for (const b of bots()) {
      players.delete(b.id);
    }

    for (let i = 0; i < 3; i++) {
      const b = makePlayer(
        "cpu-" + i,
        {
          name: BOT_NAMES[i]
        },
        false
      );

      b.x = 300 + i * 260;
      b.color = COLORS[i];

      players.set(b.id, b);
    }
  } else {
    for (const b of bots()) {
      players.delete(b.id);
    }
  }
}

function broadcast(status = "BUMP! STAY ON THE STREET") {
  const state = {
    players: [...players.values()].map(p => ({
      id: p.id,
      name: p.name,
      car: p.car,
      x: Math.round(p.x * 10) / 10,
      y: Math.round(p.y * 10) / 10,
      facing: p.facing,
      alive: p.alive,
      human: p.human,
      color: p.color
    })),
    status
  };

  io.volatile.emit("state", state);
}

function resetMatch() {
  matchEnded = false;

  syncBots();

  for (const p of players.values()) {
    p.x = 100 + Math.random() * 1000;
    p.y = FLOOR - 36;

    p.vx = 0;
    p.vy = 0;

    p.alive = true;
    p.hitCooldown = 0;
    p.jumpLock = false;
    p.onGround = true;

    p.input = {
      left: false,
      right: false,
      jump: false,
      boost: false
    };
  }

  broadcast("NEW MATCH!");
}

function endMatch(winner) {
  if (matchEnded) return;

  matchEnded = true;

  io.emit("matchEnd", {
    winnerId: winner ? winner.id : null,
    message: winner
      ? `${winner.name} の勝利！`
      : "全員が脱落しました。"
  });

  clearTimeout(endTimer);

  endTimer = setTimeout(() => {
    resetMatch();
  }, 6500);
}

io.on("connection", socket => {

  socket.on("join", data => {

    if (players.has(socket.id)) return;

    if (humans().length >= 8) {
      socket.emit("message", {
        text: "満員です。"
      });
      return;
    }

    const p = makePlayer(
      socket.id,
      data || {},
      true
    );

    players.set(socket.id, p);

    syncBots();

    socket.emit("joined", {
      id: socket.id
    });

    broadcast(`${p.name} が参戦！`);
  });

  socket.on("input", data => {
    const p = players.get(socket.id);

    if (!p || !p.alive || !data || matchEnded) return;

    p.input.left = data.left === true;
    p.input.right = data.right === true;
    p.input.jump = data.jump === true;
    p.input.boost = data.boost === true;
  });

  socket.on("ready", () => {
    if (matchEnded) {
      clearTimeout(endTimer);
      resetMatch();
    }
  });

  socket.on("disconnect", () => {
    players.delete(socket.id);

    syncBots();

    broadcast("プレイヤーが退出しました");

    const alive = [...players.values()]
      .filter(p => p.alive);

    if (
      alive.length === 1 &&
      humans().length > 0
    ) {
      endMatch(alive[0]);
    }
  });
});

// CPUの最短ターゲットを直接探す
function findTarget(p, all) {
  let target = null;
  let minDistance = Infinity;

  for (const q of all) {
    if (q.id === p.id || !q.alive) continue;

    const d = Math.abs(q.x - p.x);

    if (d < minDistance) {
      minDistance = d;
      target = q;
    }
  }

  return target;
}

function step() {
  tick++;

  const all = [...players.values()];

  if (matchEnded) return;

  // 移動・AI
  for (const p of all) {

    if (!p.alive) continue;

    if (p.hitCooldown > 0) {
      p.hitCooldown--;
    }

    // CPU
    if (!p.human) {
      const target = findTarget(p, all);

      if (target) {
        const dx = target.x - p.x;

        p.input.left = dx < -30;
        p.input.right = dx > 30;

        p.input.boost =
          Math.abs(dx) > 200;

        p.input.jump =
          Math.abs(dx) < 110 &&
          p.onGround &&
          tick % 35 === 0;
      }
    }

    // 移動
    const dir =
      (p.input.right ? 1 : 0) -
      (p.input.left ? 1 : 0);

    if (dir !== 0) {
      p.vx += dir * (p.input.boost ? 0.72 : 0.42);
      p.facing = dir;
    } else {
      p.vx *= 0.94;
    }

    const maxSpeed = p.input.boost ? 10 : 6.3;

    p.vx = Math.max(
      -maxSpeed,
      Math.min(maxSpeed, p.vx)
    );

    // ジャンプ
    if (
      p.input.jump &&
      !p.jumpLock &&
      p.onGround
    ) {
      p.vy = -12;
      p.onGround = false;
      p.jumpLock = true;
    }

    if (!p.input.jump) {
      p.jumpLock = false;
    }

    // 重力
    p.vy += 0.58;

    p.x += p.vx;
    p.y += p.vy;

    if (p.y >= FLOOR - 36) {
      p.y = FLOOR - 36;
      p.vy = 0;
      p.onGround = true;
    }

    // 脱落
    if (
      p.x < -70 ||
      p.x > W + 70 ||
      p.y > 760
    ) {
      p.alive = false;
      p.vx = 0;
      p.vy = 0;
    }
  }

  // 車同士の衝突
  for (let i = 0; i < all.length; i++) {
    const a = all[i];

    if (!a.alive) continue;

    for (let j = i + 1; j < all.length; j++) {
      const b = all[j];

      if (!b.alive) continue;

      if (
        Math.abs(a.x - b.x) < 78 &&
        Math.abs(a.y - b.y) < 55
      ) {
        if (
          a.hitCooldown === 0 ||
          b.hitCooldown === 0
        ) {
          const sign = a.x <= b.x ? -1 : 1;

          const impact = Math.max(
            2.5,
            Math.abs(a.vx - b.vx) * 0.75 + 2
          );

          a.vx += sign * impact * 0.72;
          b.vx -= sign * impact * 0.72;

          if (a.onGround) {
            a.vy = -Math.min(7, impact * 0.42);
          }

          if (b.onGround) {
            b.vy = -Math.min(7, impact * 0.42);
          }

          a.hitCooldown = 13;
          b.hitCooldown = 13;
        }
      }
    }
  }

  const alive = all.filter(p => p.alive);

  if (alive.length <= 1 && humans().length > 0) {
    endMatch(alive[0] || null);
  }

  // 通信は10回/秒
  if (tick % BROADCAST_INTERVAL === 0) {
    broadcast();
  }
}

// 20回/秒
setInterval(step, 1000 / FPS);

const port = process.env.PORT || 3000;

server.listen(port, () => {
  console.log("CAR CLASH LIGHT SERVER READY");
  console.log("Port:", port);
});
