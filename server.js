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
app.get("/health",(_req,res)=>res.json({
  ok:true,game:"CAR CLASH",mode:"500 CPU CARS + SMART DODGE + CAR STATS"
}));

const players=new Map();
const W=1200,FLOOR=500,CAR_W=78,CAR_H=42,FPS=30,STEP_MS=1000/FPS;
const BOT_NAMES=["TURBO CAT","CITY RACER","PON PON"];
const COLORS=["#f5b84a","#63c8dc","#ef8b91","#9ed17b","#bd9bfa","#f28ab8"];

let tick=0,matchEnded=false,lastStep=Date.now(),accumulator=0;
let cpuSerial=0;

function clamp(v,min,max){
  return Math.max(min,Math.min(max,Number.isFinite(v)?v:min));
}

function cleanStats(s){
  s=s&&typeof s==="object"?s:{};
  return {
    jump:Math.round(clamp(Number(s.jump),45,100)),
    attack:Math.round(clamp(Number(s.attack),45,100)),
    speed:Math.round(clamp(Number(s.speed),45,100)),
    mobility:Math.round(clamp(Number(s.mobility),45,100))
  };
}

/* 500種類のCPU専用デザインカタログ */
function makeCpuCar(index){
  const hue=(index*47)%360;
  const hue2=(hue+70+(index%5)*13)%360;
  const body=`hsl(${hue} 82% 53%)`;
  const trim=`hsl(${hue2} 90% 65%)`;
  const glass=["#b8f1ff","#d8f4ff","#fff0ba","#b7d9ff"][index%4];
  const roof=index%4;
  const spoiler=index%3;
  const wheel=index%3;
  const stripe=index%5;
  const nose=index%4;
  const bodyY=35+(index%7);
  const roofY=12+roof*2;
  const bodyPath=[
    `M 13 ${bodyY+25}`,
    `L ${nose===0?24:nose===1?34:18} ${bodyY}`,
    `Q 45 ${bodyY-8} 70 ${bodyY-8}`,
    `L 105 ${bodyY-8}`,
    `Q 125 ${bodyY-7} 143 ${bodyY+5}`,
    `L 169 ${bodyY+13}`,
    `Q 180 ${bodyY+17} 180 ${bodyY+27}`,
    `L 174 ${bodyY+34} L 18 ${bodyY+34} Z`
  ].join(" ");
  const roofPath=`M 49 ${bodyY-5} L 65 ${roofY} Q 70 ${roofY-5} 82 ${roofY-5} L 111 ${roofY-5} Q 119 ${roofY-4} 128 ${bodyY-5} Z`;
  let extra="";
  if(stripe===0)extra=`<path d="M25 ${bodyY+8} L160 ${bodyY+8}" stroke="${trim}" stroke-width="5"/>`;
  if(stripe===1)extra=`<path d="M30 ${bodyY+23} L160 ${bodyY+23}" stroke="#fff" stroke-width="3"/>`;
  if(stripe===2)extra=`<path d="M75 8 L92 8 L120 ${bodyY+28} L103 ${bodyY+28}Z" fill="${trim}"/>`;
  if(stripe===3)extra=`<path d="M30 ${bodyY+2} L50 ${bodyY-2} L50 ${bodyY+28} L30 ${bodyY+28}Z" fill="${trim}"/>`;
  if(spoiler===0)extra+=`<path d="M145 ${bodyY-9} L175 ${bodyY-17} L178 ${bodyY-11} L150 ${bodyY-4}" fill="${trim}"/>`;
  if(spoiler===1)extra+=`<path d="M150 ${bodyY-7} L177 ${bodyY-7} L177 ${bodyY-3} L150 ${bodyY-3}" stroke="${trim}" stroke-width="5"/>`;
  const wheels=wheel===0?
    `<circle cx="49" cy="${bodyY+29}" r="13" fill="#101722"/><circle cx="49" cy="${bodyY+29}" r="6" fill="${trim}"/><circle cx="143" cy="${bodyY+29}" r="13" fill="#101722"/><circle cx="143" cy="${bodyY+29}" r="6" fill="${trim}"/>`:
    `<circle cx="49" cy="${bodyY+29}" r="12" fill="#101722" stroke="${trim}" stroke-width="3"/><circle cx="143" cy="${bodyY+29}" r="12" fill="#101722" stroke="${trim}" stroke-width="3"/>`;
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100">
  <ellipse cx="100" cy="83" rx="78" ry="7" fill="#000" opacity=".2"/>
  ${wheels}
  <path d="${bodyPath}" fill="${body}" stroke="#17202b" stroke-width="3" stroke-linejoin="round"/>
  <path d="${roofPath}" fill="${trim}" stroke="#17202b" stroke-width="3"/>
  <path d="M69 ${bodyY-5} L83 ${roofY+1} L83 ${bodyY-5}Z" fill="${glass}"/>
  <path d="M88 ${roofY+1} L110 ${roofY+1} L124 ${bodyY-5} L88 ${bodyY-5}Z" fill="${glass}"/>
  ${extra}
  <path d="M16 ${bodyY+17} L30 ${bodyY+17}" stroke="#fff4b2" stroke-width="5" stroke-linecap="round"/>
  <path d="M164 ${bodyY+18} L177 ${bodyY+18}" stroke="#ff344f" stroke-width="5" stroke-linecap="round"/>
  <path d="M25 ${bodyY+27} L160 ${bodyY+27}" stroke="#17202b" stroke-width="2" opacity=".5"/>
  </svg>`;
  return "data:image/svg+xml;base64,"+Buffer.from(svg).toString("base64");
}

const CPU_CATALOG=Array.from({length:500},(_,i)=>makeCpuCar(i));

function makeCpuStats(index){
  return {
    jump:88+(index%13),
    attack:88+((index*3)%13),
    speed:88+((index*5)%13),
    mobility:88+((index*7)%13)
  };
}

function makePlayer(id,data={},human=true){
  const car=human&&typeof data.car==="string"&&
    data.car.startsWith("data:image/")&&data.car.length<180000?data.car:
    human?"":CPU_CATALOG[cpuSerial%500];

  const cpuIndex=human?-1:cpuSerial++%500;
  return {
    id,
    name:String(data.name||(human?"PLAYER":BOT_NAMES[cpuIndex%3])).slice(0,16),
    car,
    human,
    cpuIndex,
    stats:human?cleanStats(data.stats):makeCpuStats(cpuIndex),
    x:120+Math.random()*960,y:FLOOR-CAR_H,vx:0,vy:0,
    facing:Math.random()<.5?-1:1,angle:0,spin:0,squash:1,
    squashTimer:0,impact:0,alive:true,
    color:COLORS[Math.floor(Math.random()*COLORS.length)],
    input:{left:false,right:false,jump:false,boost:false},
    onGround:true,hitCooldown:0,jumpLock:false,jumpBuffer:0,
    aiJumpCooldown:0,aiDecision:0
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
      b.x=300+i*260;
      b.color=COLORS[i];
      players.set(b.id,b);
    }
  }else{
    for(const b of bots())players.delete(b.id);
  }
}

function sendAllCars(socket){
  for(const p of players.values()){
    if(p.car)socket.emit("carUpdate",{id:p.id,car:p.car});
  }
}

function announceCars(){
  for(const p of players.values()){
    if(!p.human&&p.car)io.emit("carUpdate",{id:p.id,car:p.car});
  }
}

function publicState(){
  return {
    players:[...players.values()].map(p=>({
      id:p.id,name:p.name,x:+p.x.toFixed(1),y:+p.y.toFixed(1),
      vx:+p.vx.toFixed(1),vy:+p.vy.toFixed(1),
      facing:p.facing,angle:p.angle,spin:p.spin,squash:p.squash,
      impact:p.impact,onGround:p.onGround,alive:p.alive,
      human:p.human,color:p.color,stats:p.stats
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
    p.aiJumpCooldown=0;p.onGround=true;
    p.input={left:false,right:false,jump:false,boost:false};
    i++;
  }
  announceCars();
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

    const p=makePlayer(socket.id,data||{},true);
    players.set(socket.id,p);

    if(matchEnded)resetMatch();
    else syncBots();

    sendAllCars(socket);
    if(p.car)io.emit("carUpdate",{id:p.id,car:p.car});
    announceCars();

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
    announceCars();
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
    if(!p.human&& !q.human && humans().length>1)continue;
    const d=Math.abs(q.x-p.x);
    const score=d+Math.abs(q.y-p.y)*.35;
    if(score<min){min=score;target=q;}
  }
  return target;
}

/* CPUは相手の速度と距離から突進を予測してジャンプ回避 */
function thinkCpu(p,all){
  if(p.aiJumpCooldown>0)p.aiJumpCooldown--;
  const t=findTarget(p,all);
  if(!t){
    p.input.left=false;p.input.right=false;
    p.input.boost=false;p.input.jump=false;
    return;
  }

  const dx=t.x-p.x;
  const distance=Math.abs(dx);
  const dir=dx>=0?1:-1;
  const closing=(t.vx-p.vx)*dir;
  const enemyCharging=Math.abs(t.vx)>7.5&&closing>1.5;
  const enemyNear=distance<190;
  const predictedDistance=distance-Math.max(0,closing)*5;

  /* 相手が近づいてきたら少し早めにジャンプ */
  if(p.onGround&&p.aiJumpCooldown===0&&
     ((enemyCharging&&predictedDistance<145)||
      (enemyNear&&Math.abs(t.vx)>10&&tick%4===0))){
    p.input.jump=true;
    p.jumpBuffer=5;
    p.aiJumpCooldown=48;
  }else{
    p.input.jump=false;
  }

  /* 相手のジャンプ中は着地点を狙う */
  const targetX=t.x+(t.vx||0)*(t.onGround?2:5);
  const targetDx=targetX-p.x;
  p.input.left=targetDx< -34;
  p.input.right=targetDx>34;

  /* ぶつかる直前は回避、着地後は反撃 */
  if(enemyCharging&&distance<105&&p.onGround){
    p.input.left=dir>0;
    p.input.right=dir<0;
    p.input.boost=false;
  }else{
    p.input.boost=distance>150||(!enemyCharging&&distance>70);
  }
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

  if(!p.human)thinkCpu(p,all);

  const stats=p.stats||{jump:70,attack:70,speed:70,mobility:70};
  const mobility=stats.mobility/75;
  const speed=stats.speed/75;
  const dir=(p.input.right?1:0)-(p.input.left?1:0);
  const boost=p.input.boost;

  if(dir){
    p.vx+=dir*(p.onGround?.72:.38)*mobility*(boost?1.55:1);
    p.facing=dir;
  }else{
    p.vx*=p.onGround?.985:.997;
  }

  const max=(boost?17:11.5)*(.78+speed*.22);
  p.vx=clamp(p.vx,-max,max);

  if(p.jumpBuffer>0&&!p.jumpLock&&p.onGround){
    p.vy=-(12.5+stats.jump*.045);
    p.onGround=false;p.jumpLock=true;p.jumpBuffer=0;
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
  p.angle=clamp(p.angle,-1.25,1.25);

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
      const attackA=(a.stats?.attack||70)/75;
      const attackB=(b.stats?.attack||70)/75;
      const impact=Math.max(2,speed*.72+2.5);
      const push=Math.max(2,ox*.28);

      a.x-=sign*push;b.x+=sign*push;

      if(a.hitCooldown===0||b.hitCooldown===0){
        const impulse=Math.min(19,impact);
        a.vx-=sign*impulse*.72*attackB;
        b.vx+=sign*impulse*.72*attackA;

        const lift=Math.min(14,3+impact*.46);
        a.vy-=lift*(a.onGround?1:.38)*attackB;
        b.vy-=lift*(b.onGround?1:.38)*attackA;

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
  console.log("CAR CLASH SMART CPU SERVER READY");
  console.log("Port:",port);
  lastStep=Date.now();
  gameLoop();
});
