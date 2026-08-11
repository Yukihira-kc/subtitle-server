const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*"
  }
});

// =====================
// 担当順
const order = ["A", "B", "C"];

let currentIndex = 0;
let active = null;

// 担当ごとの接続Socketを管理
const roleSockets = {
  A: new Set(),
  B: new Set(),
  C: new Set()
};

// =====================
// 接続中か判定
function isRoleConnected(role) {
  return roleSockets[role].size > 0;
}

// =====================
// 接続状態を作成
function getPresence() {
  return {
    A: isRoleConnected("A"),
    B: isRoleConnected("B"),
    C: isRoleConnected("C")
  };
}

// =====================
// 接続状態を全員へ通知
function broadcastPresence() {
  io.emit("presence", getPresence());
}

// =====================
// 次の接続中担当を探す
function findNextConnected(startIndex) {

  for (let i = 1; i <= order.length; i++) {

    const index = (startIndex + i) % order.length;
    const role = order[index];

    if (isRoleConnected(role)) {
      return {
        role,
        index
      };
    }
  }

  return null;
}

// =====================
// 現在のactiveが未接続なら次へ
function ensureActive() {

  if (active && isRoleConnected(active)) {
    return;
  }

  const next = findNextConnected(currentIndex);

  if (next) {
    active = next.role;
    currentIndex = next.index;
  } else {
    active = null;
  }

  io.emit("active", active);
}

// =====================
// Socketを担当から解除
function removeSocketFromRole(socket) {

  const role = socket.data.role;

  if (!role || !order.includes(role)) {
    return;
  }

  roleSockets[role].delete(socket.id);
  socket.data.role = null;

  // 接続が完全になくなった担当がactiveだった場合
  if (active === role && !isRoleConnected(role)) {

    const oldIndex = order.indexOf(role);
    const next = findNextConnected(oldIndex);

    if (next) {
      active = next.role;
      currentIndex = next.index;
    } else {
      active = null;
    }

    io.emit("active", active);
  }

  broadcastPresence();
}

// =====================
io.on("connection", (socket) => {

  console.log("接続:", socket.id);

  // 接続直後の状態を通知
  socket.emit("presence", getPresence());
  socket.emit("active", active);

  // =====================
  // 担当登録
  socket.on("register", ({ key }) => {

    if (!order.includes(key)) {
      return;
    }

    // 念のため既存担当を解除
    if (socket.data.role) {
      removeSocketFromRole(socket);
    }

    socket.data.role = key;
    roleSockets[key].add(socket.id);

    console.log("担当登録:", key, socket.id);

    // activeが存在しない場合は最初に接続した担当をactiveにする
    if (!active || !isRoleConnected(active)) {
      active = key;
      currentIndex = order.indexOf(key);

      io.emit("active", active);
    }

    broadcastPresence();
  });

  // =====================
  // 入力内容共有
  socket.on("typing", (data) => {
    socket.broadcast.emit("typing", data);
  });

  // =====================
  // 送信
  socket.on("send", (data) => {

    // 登録した担当本人からの送信か確認
    if (socket.data.role !== data.key) {
      console.log("担当不一致:", data.key);
      return;
    }

    // 現在の送信担当か確認
    if (data.key !== active) {
      console.log(
        "無効な送信:",
        data.key,
        "現在の送信担当:",
        active
      );
      return;
    }

    // ログ配信
    io.emit("log", data);

    // =====================
    // 次の接続中担当へ
    const next = findNextConnected(currentIndex);

    if (next) {
      active = next.role;
      currentIndex = next.index;
    } else {
      active = null;
    }

    console.log("次の送信担当:", active);

    io.emit("active", active);
  });

  // =====================
  // 切断
  socket.on("disconnect", () => {

    console.log("切断:", socket.id);

    removeSocketFromRole(socket);
  });
});

// =====================
const PORT = process.env.PORT || 3001;

server.listen(PORT, () => {
  console.log(`server running on port ${PORT}`);
});
