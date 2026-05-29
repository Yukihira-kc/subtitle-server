const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" }
});

// ✅ 固定順番
const order = ["A", "B", "C"];
let currentIndex = 0;

// ✅ 初期はA
let active = order[currentIndex];

io.on("connection", (socket) => {

  // ✅ 接続時に今のactiveを通知（これ重要）
  socket.emit("active", active);

  socket.on("typing", (data) => {
    socket.broadcast.emit("typing", data);
  });

  socket.on("send", (data) => {

    // ✅ 今の送信者チェック（順番崩れ防止）
    if (data.key !== active) {
      console.log("無効な送信:", data.key, "現在:", active);
      return;
    }

    // ✅ ログ配信
    io.emit("log", data);

    // ✅ 次へ（確実に順番移動）
    currentIndex = (currentIndex + 1) % order.length;
    active = order[currentIndex];

    console.log("次は:", active);

    io.emit("active", active);
  });

});

server.listen(3001, () => {
  console.log("server running");
});
