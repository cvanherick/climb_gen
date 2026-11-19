const test = require('node:test');
const assert = require('node:assert/strict');
const Calibration = require('../analysis/calibration');
const Video = require('../analysis/video_player');
const Model = require('../analysis/analysis_model');
const Reconstruction = require('../analysis/reconstruction');
const Feedback = require('../analysis/feedback_engine');
const IK = require('../ik');
const Board = require('../board_3d');

const square=[{x:.1,y:.1},{x:.9,y:.1},{x:.9,y:.9},{x:.1,y:.9}];
const projectCorners=[[.12,.05],[.9,.18],[.78,.8],[.16,.91]].map(([x,y])=>({x,y}));
const point=(x,y,z=0)=>({x,y,z,confidence:.98});
const close=(actual,expected,epsilon=1e-7)=>assert.ok(Math.abs(actual-expected)<epsilon,`${actual} != ${expected}`);

test('four board corners define a reversible projective calibration',()=>{
  const calibration=Calibration.calibrate(projectCorners,1.33);
  const projected=calibration.project(-72,144);
  close(projected.x,.12);close(projected.y,.05);
  const image=calibration.project(13,93);
  const board=calibration.unproject(image.x,image.y);
  close(board.x,13);close(board.y,93);
  assert.deepEqual(calibration.lift(image.x,image.y,0),[board.x,board.y,0]);
  assert.ok(calibration.lift(image.x,image.y,18).every(Number.isFinite));
  assert.throws(()=>Calibration.calibrate([square[0],square[2],square[1],square[3]]),/clockwise/);
});

test('timestamps, smoothing, visibility, and missing observations survive pose sampling',()=>{
  const raw=(t,x,visibility=.98)=>({t,image:Array.from({length:33},()=>({x,y:.4,z:0,visibility})),world:null});
  const frames=Model.smooth([raw(0,.1),raw(.086,.37,.4),raw(.17,.31),{t:.255,image:null,world:null},raw(.345,.44)]);
  assert.equal(frames[1].t,.086);
  assert.equal(frames[1].image.head.confidence,.4);
  assert.ok(frames[1].image.head.x<.37);
  assert.equal(Model.sample(frames,.086).kind,'observed');
  const between=Model.sample(frames,.128);
  assert.equal(between.kind,'interpolated');
  close(between.image.head.x,(frames[1].image.head.x+frames[2].image.head.x)/2);
  assert.equal(Model.sample(frames,.22),null);
});

test('stationary confident end effectors attach to the calibrated board, and edits replace only the chosen interval',()=>{
  const calibration=Calibration.calibrate(square);
  const holds=new Map([['11',{x:-16,y:48}],['22',{x:8,y:60}]]);
  const pin=(id)=>({...calibration.project(holds.get(id).x,holds.get(id).y),confidence:.96});
  const frames=Array.from({length:24},(_,i)=>({t:i/12,image:i===10 ? null : {
    leftHand:i<9?pin('11'):pin('22'),rightFoot:{...pin('11'),confidence:.2},
  }}));
  const contacts=Model.detectContacts(frames,calibration,holds,{},2);
  assert.deepEqual(contacts.map(c=>[c.id,c.limb]),[['11','leftHand'],['22','leftHand']]);
  const changed=Model.editContacts(contacts,{limb:'leftHand',id:'22',start:.25,end:.5});
  assert.equal(Model.contactAt(changed,.35)[0].source,'manual');
  assert.equal(Model.contactAt(changed,.15)[0].id,'11');
  assert.equal(Model.contactAt(changed,.6)[0].id,'11');
  const removed=Model.editContacts(changed,{limb:'leftHand',id:null,start:.25,end:.5});
  assert.equal(Model.contactAt(removed,.3).length,0);
  const stances=Model.contactStances(removed,2);
  assert.deepEqual(stances.find(row=>row.start===.25),{start:.25,end:.5,contacts:{}});
  assert.throws(()=>Model.editContacts(contacts,{limb:'leftHand',start:1,end:.5}));
});

test('mass weighting and time derivatives follow the observed trajectories',()=>{
  const base={head:point(4,1),pelvis:point(4,2),neck:point(4,2)};
  for(const side of ['left','right']) for(const key of ['Shoulder','Elbow','Wrist','Hand','Hip','Knee','Ankle','Heel','Foot'])base[side+key]=point(4,2);
  const center=Model.centerOfMass(base);
  close(center.x,4); assert.ok(center.y<2 && center.y>1.9);
  const frames=[0,.08,.17,.25,.34,.42,.5].map(t=>({t,image:Object.fromEntries(Object.entries(base).map(([key,p])=>[key,{...p,x:p.x+.35*t}]))}));
  const metrics=Model.motion(frames);
  close(metrics[3].velocity.x,.35);
  close(metrics[3].acceleration.x,0);
  assert.equal(Model.centerOfMass({head:point(0,0)}),null);
});

test('a fitted body retains confirmed contacts and uses the supplied height',()=>{
  const calibration=Calibration.calibrate(square);
  const world={pelvis:point(0,0),neck:point(0,-.42),head:point(0,-.65)};
  for(const [side,sign] of [['left',-1],['right',1]]) {
    for(const [key,x,y,z] of [['Shoulder',.19,-.42,0],['Elbow',.32,-.5,-.05],['Wrist',.24,-.69,-.13],['Hand',.23,-.76,-.15],
      ['Hip',.13,0,0],['Knee',.27,.29,-.24],['Ankle',.23,.61,-.16],['Heel',.23,.67,-.16],['Foot',.22,.68,-.29]]) {
      world[side+key]=point(x*sign,y,z);
    }
  }
  const image=Object.fromEntries(Object.entries(world).map(([key,p])=>[key,point(.5+p.x*.28,.56+p.y*.28)]));
  const holds=new Map([['1',{x:-11,y:102,z:1.7}],['2',{x:11,y:102,z:1.7}]]);
  const contacts=[{limb:'leftHand',id:'1',confidence:1},{limb:'rightHand',id:'2',confidence:1}];
  const pose=Reconstruction.fit({image,world},calibration,contacts,holds,174);
  assert.deepEqual(pose.points.leftHand,{x:-11,y:102});
  assert.equal(pose.depth.leftHand,1.7);
  assert.ok(pose.diagnostics.centerOfMass.z>0);
  assert.ok(pose.boneError<1.6);
  const shorter=Reconstruction.fit({image,world},calibration,contacts,holds,150);
  assert.ok(Math.abs(pose.points.leftHip.x-pose.points.rightHip.x)>Math.abs(shorter.points.leftHip.x-shorter.points.rightHip.x)+.7);
});

test('static forces balance gravity, retain bounded loads, and suppress unreliable frames',()=>{
  const points={leftHand:{x:-12,y:55},rightHand:{x:12,y:55},leftFoot:{x:-12,y:25},rightFoot:{x:12,y:25}};
  const center={x:0,y:45,z:17.5,confidence:.98};
  const pose={points,depth:Object.fromEntries(Object.keys(points).map(key=>[key,1])),
    diagnostics:{centerOfMass:center},quality:.88,boneError:.1,contactLimbIds:Object.keys(points)};
  const contacts=pose.contactLimbIds.map((limb,i)=>({limb,id:String(i),confidence:.9}));
  const motion={center,speed:.01,acceleration:{x:0,y:0}};
  const estimate=Reconstruction.estimate(pose,contacts,new Map(),motion);
  assert.equal(estimate.status,'Estimated static balance');
  close(Board.toWorld(Object.values(estimate.balance.gravity))[1],-1);
  assert.ok(estimate.balance.forceResidual<.065);
  assert.ok(estimate.balance.torqueResidual<1);
  for(const c of estimate.balance.contacts) assert.ok(Math.hypot(...Object.values(c.force))<1.8);
  const next=IK.supportForces(pose,40,estimate.balance.contacts);
  assert.ok(next.forceResidual<.065);
  assert.equal(Reconstruction.estimate(pose,contacts,new Map(),{...motion,speed:.25}).balance,undefined);
  assert.equal(Reconstruction.estimate(pose,[contacts[0]],new Map(),motion).balance,undefined);
  const misplaced={...pose,diagnostics:{centerOfMass:{...center,x:140}}};
  assert.equal(Reconstruction.estimate(misplaced,contacts,new Map(),motion).balance,undefined);
});

test('rule-based review reports a timestamped probable hand regrip',()=>{
  const contacts=[
    {limb:'rightHand',id:'21',start:.0,end:.6,confidence:.8},
    {limb:'rightHand',id:'21',start:.9,end:1.5,confidence:.7},
  ];
  const events=Feedback.analyze([],[],contacts,true);
  assert.equal(events[0].category,'Possible regrip');
  assert.equal(events[0].start,.6);
  assert.equal(events[0].end,.9);
  assert.equal(events[0].confidence,.7);
});

class FixtureVideo extends EventTarget {
  constructor(pts) { super(); this.pts=pts; this.callbacks=new Map(); this.last=0; this.clock=0; this.readyState=2; this.duration=1; }
  pause() {}
  requestVideoFrameCallback(fn) { this.callbacks.set(++this.last,fn); return this.last; }
  cancelVideoFrameCallback(id) { this.callbacks.delete(id); }
  get currentTime() { return this.clock; }
  set currentTime(t) {
    this.clock=t;this.seeking=true;
    queueMicrotask(()=>{
      this.seeking=false;
      this.dispatchEvent(new Event('seeked'));
      const mediaTime=this.pts.filter(p=>p<=t).at(-1)??0;
      const pending=[...this.callbacks.values()]; this.callbacks.clear();
      for(const callback of pending)callback(0,{mediaTime});
    });
  }
}
test('frame navigation and all dependent views use presented timestamps on variable frame rate footage',async()=>{
  const video=new FixtureVideo([0,.027,.091,.145,.244,.342]);
  const seen=[];
  const player=Video.attach(video,(t,meta)=>seen.push({t,...meta}));
  player.seek(.12);
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(seen.at(-1),{t:.091,presented:true,sampled:false});
  await player.step(1,[0,.08,.16,.24]);
  close(player.time,.145);
  assert.equal(seen.at(-1).presented,true);
  await player.step(-1,[0,.08,.16,.24]);
  close(player.time,.091);
});

test('motion metrics do not cross missing or low-confidence frames',()=>{
  const raw=(t,x,visibility=.98)=>({t,image:Array.from({length:33},()=>({x,y:.4,z:0,visibility})),world:null});
  const frames=Model.smooth([raw(0,.1),raw(.08,.2),{t:.16,image:null},raw(.24,.6),raw(.32,.7)]);
  const rows=Model.motion(frames);
  assert.equal(Model.motionAt(rows,Model.sample(frames,.15),.15),null);
  assert.equal(rows[2].speed,null);
  assert.equal(rows[1].acceleration,null);
  assert.equal(rows[3].acceleration,null);
  const weak=Model.smooth([raw(0,.1,.4),raw(.08,.2,.4),raw(.16,.3,.4)]);
  assert.equal(Model.motion(weak)[1].velocity,null);
});

test('stepping without presented frame metadata reports use of a sample timestamp',async()=>{
  const video=new FixtureVideo([]);
  video.requestVideoFrameCallback=undefined;
  const seen=[];
  const player=Video.attach(video,(t,meta)=>seen.push({t,...meta}));
  player.seek(.2);
  await new Promise(resolve=>setImmediate(resolve));
  await player.step(1,[.13,.25,.37]);
  assert.deepEqual(seen.at(-1),{t:.25,presented:false,sampled:true});
});
