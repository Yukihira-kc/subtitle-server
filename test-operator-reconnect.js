'use strict';
const assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path'),{spawn}=require('child_process'),{io}=require('socket.io-client');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'operator-reconnect-')),sockets=[];
const server=spawn(process.execPath,['server.js'],{cwd:__dirname,env:{...process.env,PORT:'3214',ROOM_STORE_PATH:path.join(dir,'rooms.json')},stdio:['ignore','pipe','pipe']});
function event(socket,name){return new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(Error('Missing '+name)),5000);socket.once(name,data=>{clearTimeout(t);resolve(data);});});}
async function connect(){const s=io('http://127.0.0.1:3214',{auth:{roomId:'practice'},transports:['websocket'],reconnection:false});sockets.push(s);await event(s,'connect');return s;}
function ack(s,name,data){return new Promise((resolve,reject)=>s.timeout(4000).emit(name,data,(e,r)=>e?reject(e):resolve(r)));}
(async()=>{try{
 await new Promise((resolve,reject)=>{server.stdout.once('data',resolve);server.once('error',reject);});
 const reviewer=await connect();await ack(reviewer,'joinReviewer',{});
 const a=await connect(),b=await connect(),c=await connect();
 for(const [s,key] of [[a,'A'],[b,'B'],[c,'C']])assert.equal((await ack(s,'register',{key,operatorId:'test-'+key})).ok,true);
 const first=event(reviewer,'reviewItem');a.emit('send',{key:'A',text:'Aの原稿'});await first;
 const typed=event(reviewer,'typing');b.emit('typing',{key:'B',value:'Bの入力途中'});await typed;
 const stranger=await connect(),refused=event(stranger,'roleError');stranger.emit('register',{key:'B',operatorId:'different-tab'});await refused;
 const replacement=await connect(),oldGone=event(b,'disconnect'),snapshot=event(replacement,'operatorSnapshot');
 assert.equal((await ack(replacement,'register',{key:'B',operatorId:'test-B'})).ok,true);await oldGone;
 assert.deepEqual((await snapshot).raw.map(r=>r.text),['Aの原稿']);
 const state=await ack(reviewer,'joinReviewer',{});assert.equal(state.inputs.B,'Bの入力途中');assert.equal(state.active,'B');
 const sent=event(reviewer,'reviewItem');replacement.emit('send',{key:'B',text:'Bの送信'});await sent;
 assert.equal((await ack(reviewer,'joinReviewer',{})).active,'C');
 const replay=event(replacement,'operatorSnapshot');await ack(replacement,'register',{key:'B',operatorId:'test-B'});assert.deepEqual((await replay).raw.map(r=>r.text),['Aの原稿','Bの送信']);
 console.log('PASS operator reconnect: same-tab takeover retains draft/turn, other tab denied, missed logs replayed, ABC rotation preserved');
 }finally{sockets.forEach(s=>s.close());await new Promise(r=>{server.once('exit',r);server.kill();});fs.rmSync(dir,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1;});
