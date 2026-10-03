'use strict';
const assert=require('node:assert/strict'),{spawn}=require('child_process'),fs=require('fs'),os=require('os'),path=require('path');
const {io}=require('socket.io-client');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'subtitle-rooms-')),store=path.join(dir,'rooms.json');
const url='http://127.0.0.1:3198',sockets=[];let server;
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function start(){server=spawn(process.execPath,['server.js'],{cwd:__dirname,env:{...process.env,PORT:'3198',ROOM_STORE_PATH:store},stdio:['ignore','pipe','pipe']});server.stderr.on('data',d=>process.stderr.write(d));await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('server start timeout')),5000);server.stdout.on('data',()=>{clearTimeout(timer);resolve();});server.on('error',reject);});}
async function stop(){sockets.splice(0).forEach(s=>s.close());if(server&&!server.killed)await new Promise(resolve=>{server.once('exit',resolve);server.kill();});}
async function api(route,method='GET',body,token){const r=await fetch(url+'/api'+route,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,...await r.json()};}
function event(s,name,ms=4000){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('event timeout: '+name)),ms);s.once(name,d=>{clearTimeout(timer);resolve(d);});});}
function ack(s,name,data){return new Promise((resolve,reject)=>s.timeout(4000).emit(name,data,(e,r)=>e?reject(e):resolve(r)));}
async function connect(id,token){const s=io(url,{forceNew:true,transports:['websocket'],auth:{roomId:id,token},reconnection:false});sockets.push(s);await event(s,'connect');return s;}
async function denied(id,token){const s=io(url,{forceNew:true,transports:['websocket'],auth:{roomId:id,token},reconnection:false});sockets.push(s);let received=false;for(const e of ['settings','caption','presence','active','log','reviewItem'])s.on(e,()=>received=true);const error=await event(s,'connect_error');assert.equal(error.data.code,'ROOM_AUTH');assert.equal(received,false);s.close();}
(async()=>{try{
 await start();
 let list=await api('/rooms');assert.equal(list.rooms.length,1);assert.equal(list.rooms[0].name,'練習用');assert.equal((await api('/rooms/practice/join','POST',{})).status,200);
 const A=await api('/rooms','POST',{name:'案件A',password:'pass-A'}),B=await api('/rooms','POST',{name:'案件B',password:'pass-B'});assert.equal(A.status,201);assert.equal(B.status,201);
 assert.equal((await api('/rooms','POST',{name:'案件A',password:'pass-A'})).status,409);
 assert.equal((await api('/rooms','POST',{name:'練習用',password:'pass-A'})).status,400);
 assert.equal((await api('/rooms/'+A.room.id+'/join','POST',{password:'wrong'})).status,401);
 assert.equal((await api('/rooms/'+A.room.id+'/join','POST',{password:'pass-A'})).status,200);
 await denied(A.room.id);await denied(A.room.id,B.token);await denied('unknown');
 const ra=await connect(A.room.id,A.token),rb=await connect(B.room.id,B.token),rp=await connect('practice');
 for(const r of [ra,rb,rp])assert.equal((await ack(r,'joinReviewer',{})).ok,true);
 const oa=await connect(A.room.id,A.token),ob=await connect(B.room.id,B.token);
 oa.emit('register',{key:'A'});ob.emit('register',{key:'A'});await wait(40);
 const leaked=[];for(const e of ['typing','reviewItem','log','caption','captionQueue','subtitleLog','settings','throughMode']){rb.on(e,v=>leaked.push([e,v]));rp.on(e,v=>leaked.push([e,v]));}
 oa.emit('typing',{key:'A',value:'Aの秘密'});await wait(30);
 assert.equal((await ack(ra,'joinReviewer',{})).inputs.A,'Aの秘密');assert.equal((await ack(rb,'joinReviewer',{})).inputs.A,'');
 const received=event(ra,'reviewItem');oa.emit('send',{key:'A',text:'案件Aの原稿',roomId:B.room.id});assert.equal((await received).text,'案件Aの原稿');
 assert.equal((await ack(ra,'setSettings',{columns:27,keyColor:'#123456'})).ok,true);
 assert.equal((await ack(ra,'setThroughMode',{enabled:true})).ok,true);
 const send={id:'shared-request-id',kind:'send',lines:['字幕A']};const first=await ack(ra,'captionAction',send);assert.equal(first.ok,true);assert.equal((await ack(ra,'captionAction',send)).id,first.id);
 const queue=await ack(ra,'captionAction',{id:'next',kind:'send',lines:['次の字幕']});assert.equal(queue.ok,true);
 let sa=await ack(ra,'joinReviewer',{}),sb=await ack(rb,'joinReviewer',{});assert.equal(sa.waiting.length,1);assert.equal(sa.display.lines[0],'字幕A');assert.equal(sa.throughMode,true);assert.equal(sa.settings.columns,27);assert.equal(sb.settings.columns,15);assert.equal(sb.throughMode,false);assert.equal(sb.raw.length,0);assert.equal(sb.waiting.length,0);assert.deepEqual(leaked,[]);
 for(const event of ['register','typing','send','joinReviewer','setSettings','setThroughMode','captionAction','captionPresented'])assert.equal((await ack(oa,event,null)).ok,false);
 assert.equal((await ack(oa,'setSettings',{columns:40})).ok,false);assert.equal((await ack(oa,'captionAction',send)).ok,false);
 // Same caption request ID remains independent in another room.
 assert.equal((await ack(rb,'captionAction',{...send,lines:['字幕B']})).ok,true);assert.equal((await ack(rb,'joinReviewer',{})).display.lines[0],'字幕B');
 // Output authority and minimum duration are room-local.
 const out=await connect(A.room.id,A.token);out.emit('joinOutput');await wait(30);out.emit('captionPresented',{id:sa.display.id,visible:true});await wait(2100);sa=await ack(ra,'joinReviewer',{});assert.equal(sa.display.lines[0],'次の字幕');assert.equal(sa.history[0].lines[0],'字幕A');
 assert.equal((await ack(rb,'joinReviewer',{})).display.lines[0],'字幕B');
 assert.equal((await api('/rooms/'+A.room.id,'DELETE',undefined,B.token)).status,403);assert.equal((await api('/rooms/practice','DELETE',undefined,A.token)).status,403);
 assert.equal((await api('/rooms/'+A.room.id+'/password','PATCH',{password:'new-pass'},B.token)).status,403);
 const disconnected=event(ra,'disconnect');const changed=await api('/rooms/'+A.room.id+'/password','PATCH',{password:'new-pass'},A.token);assert.equal(changed.status,200);await disconnected;await denied(A.room.id,A.token);
 assert.equal((await api('/rooms/'+A.room.id+'/join','POST',{password:'pass-A'})).status,401);assert.equal((await api('/rooms/'+A.room.id+'/join','POST',{password:'new-pass'})).status,200);
 const again=await connect(A.room.id,changed.token);sa=await ack(again,'joinReviewer',{});assert.equal(sa.settings.columns,27);assert.equal(sa.raw.length,1);
 const disk=fs.readFileSync(store,'utf8');assert(!disk.includes('new-pass'));assert(!disk.includes('pass-B'));assert(!disk.includes(A.token));assert(!JSON.stringify((await api('/rooms')).rooms).includes('hash'));
 await stop();await start();assert.equal((await api('/rooms')).rooms.length,3);await denied(A.room.id,changed.token);
 const login=await api('/rooms/'+A.room.id+'/join','POST',{password:'new-pass'});assert.equal(login.status,200);
 const reboot=await connect(A.room.id,login.token);assert.equal((await ack(reboot,'joinReviewer',{})).raw.length,0);
 assert.equal((await api('/rooms/'+A.room.id,'DELETE',undefined,login.token)).status,200);await denied(A.room.id,login.token);assert.equal((await api('/rooms')).rooms.length,2);
 for(let i=0;i<21;i++)await api('/rooms/'+B.room.id+'/join','POST',{password:'wrong'});assert.equal((await api('/rooms/'+B.room.id+'/join','POST',{password:'pass-B'})).status,429);
 console.log('PASS rooms: create/list, public practice, hashed credentials, access denial, all-event isolation, per-room roles/settings/queues/history/IDs, output clock, rotation/revocation, restart, delete, rate limit');
 }finally{await stop();fs.rmSync(dir,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1;});
