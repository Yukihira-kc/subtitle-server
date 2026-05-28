const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" }
});

const order = ["A", "B", "C"];
let current = 0;

io.on("connection", (socket) => {

  socket.on("typing", (data) => {
    socket.broadcast.emit("typing", data);
  });

  socket.on("send", (data) => {
    io.emit("log", data);
    current = (current + 1) % order.length;
    io.emit("active", order[current]);
  });
});

server.listen(3001);
``