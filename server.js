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

// 送信順
const order = ["A", "B", "C"];
let currentIndex = 0;

// 初期送信者はA
let active = order[currentIndex];

io.on("connection", (socket) => {

  console.log("接続:", socket.id);

  // 接続した人へ現在の送信権を通知
  socket.emit("active", active);

  // 入力内容を他の端末へリアルタイム共有
  socket.on("typing", (data) => {
    socket.broadcast.emit("typing", data);
  });

  // 送信
  socket.on("send", (data) => {

    // 現在の送信担当者以外からの送信は無効
    if (data.key !== active) {
      console.log(
        "無効な送信:",
        data.key,
        "現在の送信担当:",
        active
      );
      return;
    }

    // 全員へログを配信
    io.emit("log", data);

    // 次の担当へ
    currentIndex = (currentIndex + 1) % order.length;
    active = order[currentIndex];

    console.log("次の送信担当:", active);

    // 全員へ新しい送信担当を通知
    io.emit("active", active);
  });

  socket.on("disconnect", () => {
    console.log("切断:", socket.id);
  });

});

// RenderではPORT環境変数を使用
const PORT = process.env.PORT || 3001;

server.listen(PORT, () => {
  console.log(`server running on port ${PORT}`);
});
