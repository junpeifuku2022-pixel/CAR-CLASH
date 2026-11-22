const express=require("express");
const http=require("http");
const path=require("path");
const {Server}=require("socket.io");

const app=express();
const server=http.createServer(app);
const io=new Server(server,{
  cors:{origin:"*",methods:["GET","POST"]},
  maxHttpBufferSize:500000,
  perMessageDeflate:false,
  pingInterval:25000,
  pingTimeout:20000
});

app.use(express.static(path.join(__dirname,"public")));
app.get("/health",(_req,res)=>res.json({ok:true,game:"CAR CLASH",mode:"CUSTOM CAR + MOBILE FIT"}));

const players=new Map();
const W=1200,FLOOR=500,CAR_W=78,CAR_H=42,FPS=30,STEP_MS=1000/FPS;
const BOT_NAMES=["TURBO CAT","CITY RACER","PON PON"];
const COLORS=["#f5b84a","#63c8dc","#ef8b91","#9ed17b"];

let tick=0,matchEnded=false,lastStep=Date.now(),accumulator=0;

function makePlayer(id,data={},human=true){
  const car=typeof data.car==="string"&&data.car.startsWith("data:image/")&&data.car.length<180000?data.car:"";
  return {
    id,name:String(data.name||"PLAYER").slice(0,16),car,human,
    x:120+Math.random()*960,y:FLOOR-CAR_H,vx:0,vy:0,
    facing:Math.random()<.5?-1:1,angle:0,spin:0,squash:1,
    squashTimer:0,impact:0,alive:true,
    color:COLORS[Math.floor(Math.random()*COLORS.length)],
    input:{left:false,right:false,jump:false,boost:false},
    onGround:true,hitCooldown:0,jumpLock:false,jumpBuffer:0
  };
}
function humans(){return [...players.values()].filter(p=>p.human);}
function bots(){return [...players.values()].filter(p=>!p.human);}

function syncBots(){
  const hs=humans();
  if(hs.length===1){
    if(bots().length===3)return;
    for(const b of bots())players.delete(b.id);
    for(let i=0;i<3;i++){
      const b=makePlayer("cpu-"+i,{name:BOT_NAMES[i]},false);
      b.x=300+i*260;b.color=COLORS[i];players.set(b.id,b);
    }
  }else{
    for(const b of bots())players.delete(b.id);
  }
}

function publicState(){
  return {
    players:[...players.values()].map(p=>({
      id:p.id,name:p.name,x:+p.x.toFixed(1),y:+p.y.toFixed(1),
      vx:+p.vx.toFixed(1),vy:+p.vy.toFixed(1),
      facing:p.facing,angle:p.angle,spin:p.spin,squash:p.squash,
      impact:p.impact,onGround:p.onGround,alive:p.alive,
      human:p.human,color:p.color
    })),
    status:matchEnded?"BATTLE OVER":"BUMP! STAY ON THE STREET",
    matchEnded
  };
}
function broadcast(status){
  const s=publicState();
  if(status)s.status=status;
  io.volatile.emit("state",s);
}

function resetMatch(){
  if(!humans().length)return;
  matchEnded=false;
  syncBots();
  let i=0;
  for(const p of players.values()){
    p.x=130+(i%6)*185;p.y=FLOOR-CAR_H;p.vx=0;p.vy=0;
    p.angle=0;p.spin=0;p.squash=1;p.squashTimer=0;p.impact=0;
    p.alive=true;p.hitCooldown=0;p.jumpLock=false;p.jumpBuffer=0;
    p.onGround=true;
    p.input={left:false,right:false,jump:false,boost:false};
    i++;
  }
  broadcast("NEW MATCH!");
}

function endMatch(winner){
  if(matchEnded)return;
  matchEnded=true;
  for(const p of players.values()){
    p.input={left:false,right:false,jump:false,boost:false};
  }
  io.emit("matchEnd",{
    winnerId:winner?winner.id:null,
    message:winner?`${winner.name} の勝利！`:"全員が脱落しました。"
  });
  broadcast("BATTLE OVER");
}

io.on("connection",socket=>{
  socket.on("join",data=>{
    if(players.has(socket.id))return;
    if(humans().length>=8){
      socket.emit("message",{text:"満員です。"});
      return;
    }
    const oldCars=[...players.values()].filter(p=>p.car).map(p=>({id:p.id,car:p.car}));
    const p=makePlayer(socket.id,data||{},true);
    players.set(socket.id,p);
    if(matchEnded)resetMatch();else syncBots();
    for(const item of oldCars)socket.emit("carUpdate",item);
    if(p.car)io.emit("carUpdate",{id:p.id,car:p.car});
    socket.emit("joined",{id:socket.id});
    broadcast(`${p.name} が参戦！`);
  });

  socket.on("input",data=>{
    const p=players.get(socket.id);
    if(!p||!p.alive||!data||matchEnded)return;
    p.input.left=data.left===true;
    p.input.right=data.right===true;
    p.input.jump=data.jump===true;
    p.input.boost=data.boost===true;
    if(p.input.jump)p.jumpBuffer=5;
  });

  socket.on("disconnect",()=>{
    players.delete(socket.id);
    io.emit("carRemove",{id:socket.id});
    syncBots();
    if(!matchEnded){
      const alive=[...players.values()].filter(p=>p.alive);
      if(alive.length<=1&&humans().length>0)endMatch(alive[0]||null);
      else broadcast("プレイヤーが退出しました");
    }
  });
});

function findTarget(p,all){
  let target=null,min=Infinity;
  for(const q of all){
    if(q.id===p.id||!q.alive)continue;
    const d=Math.abs(q.x-p.x);
    if(d<min){min=d;target=q;}
  }
  return target;
}

function eliminate(p){
  if(!p.alive)return;
  p.alive=false;
  p.vx=0;p.vy=0;
  p.input={left:false,right:false,jump:false,boost:false};
}

function updatePlayer(p,all){
  if(!p.alive)return;
  if(p.hitCooldown>0)p.hitCooldown--;
  if(p.jumpBuffer>0)p.jumpBuffer--;
  if(p.squashTimer>0)p.squashTimer--;
  if(p.impact>0)p.impact*=.82;

  if(!p.human){
    const t=findTarget(p,all);
    if(t){
      const dx=t.x-p.x;
      p.input.left=dx< -28;
      p.input.right=dx>28;
      p.input.boost=Math.abs(dx)>130;
      p.input.jump=Math.abs(dx)<125&&p.onGround&&tick%28===0;
      if(p.input.jump)p.jumpBuffer=5;
    }
  }

  const dir=(p.input.right?1:0)-(p.input.left?1:0);
  const boost=p.input.boost;
  if(dir){
    p.vx+=dir*(p.onGround?.72:.38)*(boost?1.55:1);
    p.facing=dir;
  }else p.vx*=p.onGround?.985:.997;

  const max=boost?17:11.5;
  p.vx=Math.max(-max,Math.min(max,p.vx));

  if(p.jumpBuffer>0&&!p.jumpLock&&p.onGround){
    p.vy=-15.5;p.onGround=false;p.jumpLock=true;p.jumpBuffer=0;
  }
  if(!p.input.jump)p.jumpLock=false;

  p.vy=Math.min(19,p.vy+.72);
  p.x+=p.vx;p.y+=p.vy;

  if(p.y>=FLOOR-CAR_H){
    const landing=p.vy;
    p.y=FLOOR-CAR_H;p.vy=0;
    if(!p.onGround&&landing>5){
      p.squash=.68;p.squashTimer=9;
      p.spin+=p.vx*.003;p.impact=Math.min(1,landing/18);
    }
    p.onGround=true;
  }else p.onGround=false;

  if(p.onGround){
    p.spin*=.82;p.angle+=(0-p.angle)*.13;
  }else{
    p.spin+=p.vx*.0009;p.angle+=p.spin;p.spin*=.995;
  }
  if(p.squashTimer<=0)p.squash+=(1-p.squash)*.22;
  p.angle=Math.max(-1.25,Math.min(1.25,p.angle));

  if(p.x< -CAR_W/2||p.x>W+CAR_W/2||p.y>620)eliminate(p);
}

function collideCars(all){
  for(let i=0;i<all.length;i++){
    const a=all[i];if(!a.alive)continue;
    for(let j=i+1;j<all.length;j++){
      const b=all[j];if(!b.alive)continue;
      const dx=b.x-a.x,dy=b.y-a.y;
      if(Math.abs(dx)>CAR_W||Math.abs(dy)>58)continue;
      const ox=CAR_W-Math.abs(dx),oy=58-Math.abs(dy);
      if(ox<=0||oy<=0)continue;
      const sign=dx>=0?1:-1;
      const speed=Math.abs(a.vx-b.vx);
      const impact=Math.max(2,speed*.85+2.5);
      const push=Math.max(2,ox*.28);
      a.x-=sign*push;b.x+=sign*push;
      if(a.hitCooldown===0||b.hitCooldown===0){
        const impulse=Math.min(18,impact);
        a.vx-=sign*impulse*.78;b.vx+=sign*impulse*.78;
        const lift=Math.min(13,3.2+impact*.48);
        a.vy-=lift*(a.onGround?1:.38);
        b.vy-=lift*(b.onGround?1:.38);
        a.onGround=false;b.onGround=false;
        a.spin-=sign*Math.min(.18,impact*.012);
        b.spin+=sign*Math.min(.18,impact*.012);
        a.angle-=sign*.12;b.angle+=sign*.12;
        const squash=Math.max(.62,1-impact*.018);
        a.squash=squash;b.squash=squash;
        a.squashTimer=8;b.squashTimer=8;
        a.impact=Math.min(1,impact/16);
        b.impact=Math.min(1,impact/16);
        a.hitCooldown=7;b.hitCooldown=7;
      }
    }
  }
}

function step(){
  tick++;
  if(matchEnded)return;
  const all=[...players.values()];
  for(const p of all)updatePlayer(p,all);
  collideCars(all);
  const alive=all.filter(p=>p.alive);
  if(alive.length<=1&&humans().length>0)endMatch(alive[0]||null);
  broadcast();
}

function gameLoop(){
  const now=Date.now();
  accumulator+=Math.min(now-lastStep,100);
  lastStep=now;
  let count=0;
  while(accumulator>=STEP_MS&&count<3){
    step();accumulator-=STEP_MS;count++;
  }
  if(count===3&&accumulator>STEP_MS*3)accumulator=0;
  setTimeout(gameLoop,Math.max(1,STEP_MS-accumulator));
}

const port=process.env.PORT||3000;
server.listen(port,()=>{
  console.log("CAR CLASH CUSTOM CAR SERVER READY");
  console.log("Port:",port);
  lastStep=Date.now();
  gameLoop();
});
