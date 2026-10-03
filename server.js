const express = require('express');
const path = require('path');
const http = require('http');
const {Server} = require('socket.io');
const app = express();
const server = http.createServer(app);
if(process.env.LOCAL_TEST_FRONTEND==='1'){
  app.use('/test',express.static(path.resolve(__dirname,'../subtitle-ui')));
}
app.get('/', (req,res)=>res.json({ok:true,version:'v29'}));
const Pagination=require('./pagination.js');
const io=new Server(server,{cors:{origin:'*'}});
function createRoomRuntime(roomId){
const channel='room:'+roomId,reviewChannel=channel+':reviewers';
const broadcast=()=>io.to(channel);
let columnsInitialized=false;
const order=['A','B','C'], inputs={A:'',B:'',C:''};
let active=null,reviewer=null,seq=0;
let currentIndex=0;
const roleSockets={A:new Set(),B:new Set(),C:new Set()};
function isRoleConnected(role){return roleSockets[role].size>0;}
function getPresence(){return {A:isRoleConnected('A'),B:isRoleConnected('B'),C:isRoleConnected('C')};}
function broadcastPresence(){broadcast().emit('presence',getPresence());}
function findNextConnected(startIndex){
  for(let i=1;i<=order.length;i++){
    const index=(startIndex+i)%order.length,role=order[index];
    if(isRoleConnected(role))return {role,index};
  }
  return null;
}
function removeSocketFromRole(socket){
  const role=socket.data.role;
  if(!order.includes(role))return;
  roleSockets[role].delete(socket.id);socket.data.role=null;
  if(!isRoleConnected(role)){inputs[role]='';broadcast().emit('typing',{key:role,value:''});}
  if(active===role&&!isRoleConnected(role)){
    const next=findNextConnected(order.indexOf(role));
    active=next?next.role:null;if(next)currentIndex=next.index;
    broadcast().emit('active',active);
  }
  broadcastPresence();
}
const session=Date.now().toString(36),raw=[],history=[],requests=new Map();
let settings={columns:15,mode:'page',keyColor:'#00ff00',fontSize:32,lineCount:2,captionFont:'noto-sans-jp',textColor:'#ffffff',outline:true,fontWeight:'normal'};
let throughMode=false;
let display={lines:[],id:0};
let displayItem=null,displayStartedAt=0,displayTimer=null;
const waiting=[];
const outputs=new Set();
let displayAuthority=null;
function authority(){return outputs.values().next().value||reviewer;}
function resetClock(){if(displayTimer)clearTimeout(displayTimer);displayTimer=null;displayStartedAt=0;displayAuthority=authority();broadcast().emit('caption',display);}
const MIN_DISPLAY_MS=2000;
function normalizeLine(text){
  const chars=[...String(text)];
  if(chars.length===settings.columns+1&&/[。、]$/.test(text)){
    chars[chars.length-1]=chars[chars.length-1]==='。'?'｡':'､';
  }
  return chars.join('');
}
function wrapLine(text){const out=[];let current='',used=0;for(const ch of [...text]){const weight=(ch==='｡'||ch==='､')?0.5:1;if(current&&used+weight>settings.columns+0.5){out.push(current);current='';used=0;}current+=ch;used+=weight;}if(current||!out.length)out.push(current);return out;}
function queueState(){io.to(reviewChannel).emit('captionQueue',waiting.slice());}
function finishCurrent(){if(!displayItem)return;if(!displayItem.presented){displayItem=null;return;}history.push(displayItem);io.to(reviewChannel).emit('subtitleLog',displayItem);displayItem=null;}
function showQueued(){
  if(!waiting.length)return;
  if(displayItem){
    if(!displayStartedAt)return;
    const remaining=MIN_DISPLAY_MS-(Date.now()-displayStartedAt);
    if(remaining>0){
      if(displayTimer)clearTimeout(displayTimer);
      displayTimer=setTimeout(()=>{displayTimer=null;showQueued();},remaining);
      return;
    }
    finishCurrent();
  }
  const item=waiting.shift();displayItem=item;displayStartedAt=0;displayAuthority=authority();
  const previous=display.columns===item.columns&&display.lineCount===item.lineCount?display.lines:[];
  display={id:item.id,columns:item.columns,lineCount:item.lineCount,lines:settings.mode==='page'?item.lines:[...previous,...item.lines].slice(-item.lineCount)};
  broadcast().emit('caption',display);queueState();
  if(waiting.length)showQueued();
}
function enqueueCaption(lines){
  const pages=Pagination.pages(lines,settings.columns,settings.lineCount);
  const items=pages.map(lines=>({id:++seq,lines,columns:settings.columns,lineCount:settings.lineCount,at:Date.now()}));
  waiting.push(...items);queueState();showQueued();
  return items;
}
function clearCurrent(){
  if(displayTimer){clearTimeout(displayTimer);displayTimer=null;}
  waiting.length=0;finishCurrent();display={id:++seq,lines:[]};displayStartedAt=0;broadcast().emit('caption',display);queueState();showQueued();
}
function presence(){return getPresence();}
function state(){broadcast().emit('presence',presence());broadcast().emit('active',active);}
function next(after){const p=presence(),start=order.indexOf(after);return [1,2,3].map(n=>order[(start+n+3)%3]).find(k=>p[k])||null;}
function snapshot(s){s.emit('settings',settings);s.emit('caption',display);}
function connect(s){
  snapshot(s);s.emit('version','v29');s.emit('presence',getPresence());s.emit('active',active);
  s.on('joinOutput',()=>{outputs.add(s.id);if(authority()!==displayAuthority)resetClock();else s.emit('caption',display);});
  s.on('captionPresented',({id,visible}={})=>{
    if(s.id!==authority()||!displayItem||id!==display.id)return;
    if(!visible){if(displayTimer)clearTimeout(displayTimer);displayTimer=null;displayStartedAt=0;return;}
    if(!displayStartedAt){displayItem.presented=true;displayStartedAt=Date.now();showQueued();}
  });
  s.on('register',({key}={})=>{
    if(!order.includes(key))return;
    if(s.id===reviewer)return;
    if([...roleSockets[key]].some(id=>id!==s.id)){s.emit('roleError','この担当は接続中です');return;}
    if(s.data.role&&s.data.role!==key)removeSocketFromRole(s);
    s.data.role=key;roleSockets[key].add(s.id);
    if(!active||!isRoleConnected(active)){active=key;currentIndex=order.indexOf(key);}
    state();Object.entries(inputs).forEach(([key,value])=>s.emit('typing',{key,value}));
  });
  s.on('typing',({key,value}={})=>{if(key!==s.data.role||!order.includes(key))return;inputs[key]=String(value||'');s.to(channel).emit('typing',{key,value:inputs[key]});});
  s.on('send',({key,text}={})=>{
    if(key!==s.data.role||key!==active)return;
    const item={id:++seq,key,text:String(text||''),at:Date.now()};raw.push(item);inputs[key]='';
    broadcast().emit('log',item);io.to(reviewChannel).emit('reviewItem',item);broadcast().emit('typing',{key,value:''});
    const following=findNextConnected(currentIndex);
    active=following?following.role:null;if(following)currentIndex=following.index;state();
  });
  s.on('joinReviewer',(_,ack)=>{
    if(s.data.role||reviewer&&reviewer!==s.id){if(typeof ack==='function')ack({ok:false,error:'校閲者は既に接続中です'});return;}
    reviewer=s.id;s.join(reviewChannel);if(authority()!==displayAuthority)resetClock();
    if(typeof ack==='function')ack({ok:true,session,raw,history,waiting:waiting.slice(),display,settings,inputs,presence:presence(),active,throughMode,columnsInitialized});
  });
  s.on('setSettings',(change={},ack)=>{
    if(s.id!==reviewer){if(typeof ack==='function')ack({ok:false});return;}
    if(!change||typeof change!=='object')return;
    if(Number.isInteger(change.columns)&&change.columns>=10&&change.columns<=40){settings.columns=change.columns;columnsInitialized=true;}
    if(Number.isInteger(change.lineCount)&&change.lineCount>=1&&change.lineCount<=5)settings.lineCount=change.lineCount;
    if(Number.isInteger(change.fontSize)&&change.fontSize>=16&&change.fontSize<=64)settings.fontSize=change.fontSize;
    if(['noto-sans-jp','noto-serif-jp'].includes(change.captionFont))settings.captionFont=change.captionFont;
    if(/^#[0-9a-f]{6}$/i.test(change.textColor||''))settings.textColor=change.textColor;
    if(typeof change.outline==='boolean')settings.outline=change.outline;
    if(['normal','bold'].includes(change.fontWeight))settings.fontWeight=change.fontWeight;
    if(['page','scroll'].includes(change.mode))settings.mode=change.mode;
    if(/^#[0-9a-f]{6}$/i.test(change.keyColor||''))settings.keyColor=change.keyColor;
    broadcast().emit('settings',settings);if(typeof ack==='function')ack({ok:true});
  });
  s.on('setThroughMode',({enabled}={},ack)=>{
    if(s.id!==reviewer){if(typeof ack==='function')ack({ok:false,error:'校閲者として未接続です'});return;}
    throughMode=enabled===true;broadcast().emit('throughMode',throughMode);
    if(typeof ack==='function')ack({ok:true,enabled:throughMode});
  });
  s.on('captionAction',(request,ack)=>{
    const reply=x=>{if(typeof ack==='function')ack(x);};
    if(s.id!==reviewer)return reply({ok:false,error:'校閲者として未接続です'});
    if(!request||typeof request.id!=='string')return reply({ok:false,error:'送出IDがありません'});
    if(requests.has(request.id))return reply(requests.get(request.id));
    let resultId=display.id;
    if(request.kind==='out'){
      clearCurrent();
      resultId=display.id;
    }
    else if(request.kind==='send') {
      if(!Array.isArray(request.lines)||request.lines.length<1||request.lines.length>2||request.lines.some(x=>typeof x!=='string'||x.length>10000))return reply({ok:false,error:'送出内容が不正です'});
      const items=enqueueCaption(request.lines);
      resultId=items[0].id;
    }
    else return reply({ok:false,error:'送出操作が不正です'});
    const result={ok:true,id:resultId,queued:request.kind!=='out'};requests.set(request.id,result);reply(result);
  });
  s.on('disconnect',()=>{outputs.delete(s.id);if(reviewer===s.id)reviewer=null;if(authority()!==displayAuthority)resetClock();removeSocketFromRole(s);});
}
return {connect,dispose(){if(displayTimer)clearTimeout(displayTimer);waiting.length=0;raw.length=0;history.length=0;requests.clear();}};
}
require('./rooms')(app,io,createRoomRuntime);
const PORT=Number(process.env.PORT)||3001;
server.listen(PORT,'0.0.0.0',()=>console.log('subtitle server v29 on port '+PORT));
