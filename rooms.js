'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {promisify} = require('util');
const scrypt = promisify(crypto.scrypt);

// Only room definitions and salted password hashes are stored. Live captions stay in memory.
module.exports = function installRooms(app, io, createRuntime) {
  const file = process.env.ROOM_STORE_PATH || path.join(__dirname, '.data', 'rooms.json');
  const rooms = new Map(), tokens = new Map(), limits = new Map();
  const TOKEN_MS = 7 * 24 * 60 * 60 * 1000;
  let hashJobs = 0, creating = 0;
  function publicRoom(room) { return {id:room.id,name:room.name,practice:room.id==='practice',protected:room.id!=='practice',pin4:!!room.pin4}; }
  function add(def) { const room={...def};room.runtime=createRuntime(room.id);rooms.set(room.id,room);return room; }
  add({id:'practice',name:'練習用',generation:0});
  if (fs.existsSync(file)) {
    const saved=JSON.parse(fs.readFileSync(file,'utf8'));
    if(!Array.isArray(saved)||saved.length>100)throw new Error('Invalid room store');
    for(const def of saved) {
      if(!def||!/^[a-f0-9-]{36}$/.test(def.id)||typeof def.name!=='string'||!def.name.trim()||def.name.length>80||!/^[a-f0-9]{32}$/.test(def.salt)||!/^[a-f0-9]{64}$/.test(def.hash)||!Number.isSafeInteger(def.generation)||def.generation<1||rooms.has(def.id))throw new Error('Invalid room definition');
      add(def);
    }
  }
  function persist() {
    const definitions=[...rooms.values()].filter(r=>r.id!=='practice').map(({id,name,salt,hash,generation,pin4})=>({id,name,salt,hash,generation,pin4:!!pin4}));
    fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
    const temp=file+'.tmp';
    fs.writeFileSync(temp,JSON.stringify(definitions),{mode:0o600});fs.renameSync(temp,file);
  }
  function limited(key,max,windowMs) {
    const now=Date.now();let entry=limits.get(key);
    if(!entry||now>entry.until){entry={count:0,until:now+windowMs};limits.set(key,entry);}
    return ++entry.count>max;
  }
  const cleanup=setInterval(()=>{const now=Date.now();for(const [k,v] of limits)if(now>v.until)limits.delete(k);for(const [k,v] of tokens)if(now>v.until)tokens.delete(k);},60000);cleanup.unref();
  function issue(room) {
    const token=crypto.randomBytes(32).toString('hex');tokens.set(token,{roomId:room.id,generation:room.generation,until:Date.now()+TOKEN_MS});return token;
  }
  function authorized(room,token) { const session=typeof token==='string'&&tokens.get(token);return !!(session&&session.roomId===room.id&&session.generation===room.generation&&Date.now()<session.until); }
  async function digest(password,salt) {
    if(hashJobs>=8){const e=new Error('混み合っています。少し待って再試行してください。');e.status=429;throw e;}
    hashJobs++;try{return Buffer.from(await scrypt(password,salt,32)).toString('hex');}finally{hashJobs--;}
  }
  function normalizePassword(value) {return typeof value==='string'?value.replace(/[０-９]/g,ch=>String.fromCharCode(ch.charCodeAt(0)-0xfee0)):value;}
  function validPassword(value) {return typeof value==='string'&&/^[0-9]{4}$/.test(value);}
  function bearer(req) {return (req.get('authorization')||'').replace(/^Bearer /,'');}
  function revoke(room) {
    for(const [token,s] of tokens)if(s.roomId===room.id)tokens.delete(token);
    for(const socket of io.sockets.sockets.values())if(socket.data.roomId===room.id){socket.emit('roomRevoked');socket.disconnect(true);}
  }
  function endpoint(fn) {return (req,res)=>Promise.resolve().then(()=>fn(req,res)).catch(e=>{console.error('Room request failed:',e.code||e.status||e.name);if(!res.headersSent)res.status(e.status||500).json({error:e.status?e.message:'ルームを保存できませんでした。時間をおいて再試行してください。'});});}
  function requireRoom(req,res) {
    const room=rooms.get(req.params.id);
    if(!room){res.status(404).json({error:'ルームがありません。'});return null;}
    if(room.id==='practice'||!authorized(room,bearer(req))){res.status(403).json({error:'この案件ルームへの入室認証が必要です。'});return null;}
    return room;
  }
  app.set('trust proxy',1);
  app.use('/api', (req,res,next)=>{
    res.set({'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type, Authorization','Access-Control-Allow-Methods':'GET, POST, PATCH, DELETE, OPTIONS','Cache-Control':'no-store'});
    if(req.method==='OPTIONS')return res.sendStatus(204);next();
  });
  app.use('/api',require('express').json({limit:'8kb'}));
  app.get('/api/rooms',(req,res)=>res.json({rooms:[...rooms.values()].map(publicRoom)}));
  app.get('/api/rooms/:id',(req,res)=>{const room=rooms.get(req.params.id);if(!room)return res.status(404).json({error:'ルームがありません。'});res.json({room:publicRoom(room)});});
  app.post('/api/rooms',endpoint(async(req,res)=>{
    const name=typeof req.body?.name==='string'?req.body.name.trim():'';
    const password=normalizePassword(req.body?.password);
    if(!name||name.length>80||name==='練習用'||!validPassword(password))return res.status(400).json({error:'案件名は1〜80文字、パスワードは数字4桁で入力してください。「練習用」は常設ルーム名です。'});
    if([...rooms.values()].some(r=>r.name===name))return res.status(409).json({error:'同じ案件名のルームがあります。別の名前を付けてください。'});
    if(rooms.size+creating>=101)return res.status(409).json({error:'案件ルームは100件までです。終了したルームを削除してください。'});
    if(limited('create:'+req.ip,10,3600000))return res.status(429).json({error:'作成が続いています。時間をおいて再試行してください。'});
    creating++;
    try {
      const salt=crypto.randomBytes(16).toString('hex'),hash=await digest(password,salt);
      if([...rooms.values()].some(r=>r.name===name))return res.status(409).json({error:'同じ案件名のルームがあります。'});
      const room=add({id:crypto.randomUUID(),name,salt,hash,generation:1,pin4:true});
      try{persist();}catch(e){rooms.delete(room.id);room.runtime.dispose();throw e;}
      res.status(201).json({room:publicRoom(room),token:issue(room)});
    } finally {creating--;}
  }));
  app.post('/api/rooms/:id/join',endpoint(async(req,res)=>{
    const room=rooms.get(req.params.id);if(!room)return res.status(404).json({error:'ルームがありません。'});
    if(room.id==='practice')return res.json({room:publicRoom(room)});
    if(authorized(room,bearer(req)))return res.json({room:publicRoom(room),token:bearer(req)});
    if(limited('join:'+req.ip+':'+room.id,20,600000))return res.status(429).json({error:'認証が続けて失敗しています。10分ほど待って再試行してください。'});
    const generation=room.generation;
    const password=normalizePassword(req.body?.password);
    const candidate=room.pin4?password:req.body?.password;
    if(!(room.pin4?validPassword(candidate):typeof candidate==='string'&&candidate.length>=4&&candidate.length<=128)||!crypto.timingSafeEqual(Buffer.from(await digest(candidate,room.salt),'hex'),Buffer.from(room.hash,'hex')))return res.status(401).json({error:'パスワードが違います。'});
    if(rooms.get(room.id)!==room||room.generation!==generation)return res.status(409).json({error:'ルームの設定が変わりました。再度入室してください。'});
    res.json({room:publicRoom(room),token:issue(room)});
  }));
  app.patch('/api/rooms/:id/password',endpoint(async(req,res)=>{
    const room=requireRoom(req,res);if(!room)return;
    const password=normalizePassword(req.body?.password);
    if(!validPassword(password))return res.status(400).json({error:'パスワードは数字4桁で入力してください。'});
    const generation=room.generation,salt=crypto.randomBytes(16).toString('hex'),hash=await digest(password,salt);
    if(rooms.get(room.id)!==room||generation!==room.generation||!authorized(room,bearer(req)))return res.status(409).json({error:'ルームの設定が変わりました。再度入室してください。'});
    const old={salt:room.salt,hash:room.hash,generation:room.generation,pin4:room.pin4};Object.assign(room,{salt,hash,generation:generation+1,pin4:true});
    try{persist();}catch(e){Object.assign(room,old);throw e;}
    revoke(room);res.json({room:publicRoom(room),token:issue(room)});
  }));
  app.delete('/api/rooms/:id',endpoint((req,res)=>{
    const room=requireRoom(req,res);if(!room)return;rooms.delete(room.id);
    try{persist();}catch(e){rooms.set(room.id,room);throw e;}
    revoke(room);room.runtime.dispose();res.json({ok:true});
  }));
  io.use((socket,next)=>{
    // v28 clients without a room can only enter the public practice room.
    const id=socket.handshake.auth?.roomId||'practice',room=rooms.get(id);
    if(!room||room.id!=='practice'&&!authorized(room,socket.handshake.auth?.token)){
      const err=new Error('ルームの認証が必要です。');err.data={code:'ROOM_AUTH'};return next(err);
    }
    socket.data.roomId=room.id;
    socket.use((packet,done)=>{
      const objectEvents=['captionPresented','register','typing','send','joinReviewer','setSettings','setThroughMode','captionAction'];
      if(objectEvents.includes(packet[0])&&(!packet[1]||typeof packet[1]!=='object'||Array.isArray(packet[1]))){const reply=packet[packet.length-1];if(typeof reply==='function')reply({ok:false,error:'送信内容が不正です。'});return;}
      if(rooms.get(id)!==room||id!=='practice'&&!authorized(room,socket.handshake.auth?.token)){socket.emit('roomRevoked');socket.disconnect(true);return;}
      done();
    });
    next();
  });
  io.on('connection',socket=>{
    const room=rooms.get(socket.data.roomId);socket.join('room:'+room.id);socket.emit('roomInfo',publicRoom(room));room.runtime.connect(socket);
  });
  return rooms;
};
