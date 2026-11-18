
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  maxHttpBufferSize: 2e6
});

app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (_req, res) => {
  res.json({ ok: true, game: "CAR CLASH" });
});

const players = new Map();

const botNames = [
  "TURBO CAT",
  "CITY RACER",
  "PON PON",
  "BLUE COMET",
  "MOMO DRIVE",
  "NIGHT TAXI"
];

const W = 1200;
const FLOOR = 500;

let tick = 0;
let matchEnded = false;
let endTimer = null;

function makePlayer(id, data, human) {
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
    lives: 1,

    color: [
      "#f5b84a",
      "#63c8dc",
      "#ef8b91",
      "#9ed17b"
    ][Math.floor(Math.random() * 4)],

    input: {
      left: false,
      right: false,
      jump: false,
      boost: false
    },

    onGround: true,
    hitCooldown: 0,
    jumpLock: false,
    aiThink: 0
  };
}

function humans() {
  return [...players.values()].filter(p => p.human);
}

function bots() {
  return [...players.values()].filter(p => !p.human);
}

function broadcast(statusText = "BUMP! STAY ON THE STREET") {
  io.emit("state", {
    players: [...players.values()].map(p => ({
      id: p.id,
      name: p.name,
      car: p.car,
      x: p.x,
      y: p.y,
      facing: p.facing,
      alive: p.alive,
      human: p.human,
      color: p.color
    })),
    status: statusText
  });
}

function syncBots() {
  const hs = humans();

  for (const b of bots()) {
    players.delete(b.id);
  }

  if (hs.length === 1) {
    for (let i = 0; i < 3; i++) {
      const id = "cpu-" + i;

      const b = makePlayer(
        id,
        {
          name: botNames[(tick + i) % botNames.length]
        },
        false
      );

      b.x = 300 + i * 260;

      b.color = [
        "#f5b84a",
        "#65c9dc",
        "#ef8b91"
      ][i];

      players.set(id, b);
    }
  }
}

function resetMatch() {
  matchEnded = false;

  for (const p of players.values()) {
    p.x = 100 + Math.random() * 1000;
    p.y = FLOOR - 36;
    p.vx = 0;
    p.vy = 0;
    p.alive = true;
    p.lives = 1;
    p.hitCooldown = 0;
  }

  syncBots();
}

function endMatch(winner) {
  if (matchEnded) return;

  matchEnded = true;

  const msg = winner
    ? `${winner.name} の勝利！`
    : "全員が脱落しました。";

  io.emit("matchEnd", {
    winnerId: winner?.id || null,
    message: msg
  });

  clearTimeout(endTimer);

  endTimer = setTimeout(() => {
    resetMatch();
  }, 6500);
}

io.on("connection", socket => {

  socket.on("join", data => {

    if (humans().length >= 8) {
      socket.emit("message", {
        text: "満員です。少し待ってから接続してください。"
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

    if (!p || !p.alive || !data) return;

    for (const k of [
      "left",
      "right",
      "jump",
      "boost"
    ]) {
      p.input[k] = !!data[k];
    }
  });

  socket.on("ready", () => {
    if (matchEnded) resetMatch();
  });

  socket.on("disconnect", () => {

    players.delete(socket.id);

    syncBots();

    broadcast("プレイヤーが退出しました");

    const alive = [...players.values()]
      .filter(p => p.alive);

    if (alive.length === 1 && humans().length > 0) {
      endMatch(alive[0]);
    }
  });
});

function step() {

  tick++;

  const all = [...players.values()];
  const hs = humans();

  if (hs.length !== 1 && bots().length) {
    syncBots();
  }

  for (const p of all) {

    if (!p.alive) continue;

    if (p.hitCooldown > 0) {
      p.hitCooldown--;
    }

    // CPUの行動
    if (!p.human) {

      const targets = all.filter(q =>
        q.id !== p.id && q.alive
      );

      const target = targets.sort((a, b) =>
        Math.abs(a.x - p.x) -
        Math.abs(b.x - p.x)
      )[0];

      if (target) {

        p.input.left = target.x < p.x - 30;
        p.input.right = target.x > p.x + 30;

        p.input.boost =
          Math.abs(target.x - p.x) > 170 &&
          Math.random() < 0.85;

        p.input.jump =
          Math.abs(target.x - p.x) < 115 &&
          p.onGround &&
          Math.random() < 0.035;
      }
    }

    // 移動
    const dir =
      (p.input.right ? 1 : 0) -
      (p.input.left ? 1 : 0);

    if (dir) {
      p.vx += dir * (p.input.boost ? 0.72 : 0.42);
      p.facing = dir;
    } else {
      p.vx *= 0.94;
    }

    const max = p.input.boost ? 10 : 6.3;

    p.vx = Math.max(
      -max,
      Math.min(max, p.vx)
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

    // ステージ外へ落下
    if (
      p.x < -70 ||
      p.x > W + 70 ||
      p.y > 760
    ) {
      p.alive = false;
      p.vx = 0;
    }
  }

  // 車同士の衝突
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {

      const a = all[i];
      const b = all[j];

      if (!a.alive || !b.alive) continue;

      if (
        Math.abs(a.x - b.x) < 78 &&
        Math.abs(a.y - b.y) < 55
      ) {

        const sign = a.x <= b.x ? -1 : 1;

        const impact = Math.max(
          2.5,
          Math.abs(a.vx - b.vx) * 0.75 + 2
        );

        if (
          a.hitCooldown === 0 ||
          b.hitCooldown === 0
        ) {

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

  if (
    !matchEnded &&
    alive.length === 1 &&
    humans().length > 0
  ) {
    endMatch(alive[0]);
  }

  if (
    !matchEnded &&
    alive.length === 0 &&
    humans().length > 0
  ) {
    endMatch(null);
  }

  if (tick % 2 === 0) {
    broadcast();
  }
}

setInterval(step, 1000 / 30);

const port = process.env.PORT || 3000;

server.listen(port, () => {
  console.log(`CAR CLASH server listening on ${port}`);
});
