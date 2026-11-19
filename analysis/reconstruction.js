/* Single-camera body fitting against video landmarks and board anchors. */
(function (root) {
  const M = root.ClimbGenAnalysisModel || require('./analysis_model');
  const IK = root.ClimbGenIK || require('../ik');
  const magnitude = f => Math.hypot(f.x,f.y,f.z);
  const delta = (a,b) => a.map((x,i)=>x-b[i]);
  function fit(frame, calibration, contacts, holds, height, depthHint) {
    if (!frame?.image || !frame.world || !calibration) return null;
    const p=frame.image, w=frame.world;
    if (Math.min(M.confidence(p.pelvis),M.confidence(p.neck))<.33) return null;
    const quality = Object.values(p).reduce((sum,q)=>sum+M.confidence(q),0)/Object.keys(p).length;
    const size=height/2.54;
    // Normalize the model's metric skeleton to the user's height using
    // stable segment lengths. Outlier frames stay close to the metric prior.
    const dist=(a,b)=>magnitude({ x:w[a].x-w[b].x,y:w[a].y-w[b].y,z:w[a].z-w[b].z });
    const proportion=[['neck','pelvis',.288],['leftHip','leftKnee',.248],['rightHip','rightKnee',.248],
      ['leftKnee','leftAnkle',.246],['rightKnee','rightAnkle',.246]];
    const factors=proportion.map(([a,b,f])=>size*f/Math.max(.01,dist(a,b))).sort((a,b)=>a-b);
    const scale=M.clamp(factors[2],29,52);
    const relative = Object.fromEntries(Object.keys(w).map(key=>[key,
      calibration.relative(w[key].x-w.pelvis.x,w[key].y-w.pelvis.y,w[key].z-w.pelvis.z).map(x=>x*scale)]));
    const locks = new Map();
    const depthVotes=[];
    for (const c of contacts) {
      const h=holds.get(c.id);
      if (!h || !relative[c.limb] || c.confidence<.42) continue;
      locks.set(c.limb,[h.x,h.y,h.z??0]);
      depthVotes.push((h.z??0)-relative[c.limb][2]);
    }
    depthVotes.sort((a,b)=>a-b);
    const inferredDepth=depthVotes.length ? depthVotes[Math.floor(depthVotes.length/2)] : 13;
    const depth=M.clamp(depthHint==null ? inferredDepth : M.lerp(depthHint,inferredDepth,.45),4,36);
    const center=calibration.lift(p.pelvis.x,p.pelvis.y,depth);
    const goals={};
    const positions={};
    for (const [key,q] of Object.entries(p)) {
      const offset=relative[key];
      const predicted=center.map((x,i)=>x+offset[i]);
      const ray=calibration.lift(q.x,q.y,Math.max(1,predicted[2]));
      goals[key]=predicted.map((x,i)=>M.lerp(x,ray[i],.68*M.confidence(q)));
      positions[key]=locks.get(key)?.slice() ?? goals[key].slice();
    }
    const bones=[['leftHip','rightHip',.16],['leftShoulder','rightShoulder',.22]];
    for (const side of ['left','right']) for (const [a,b,length] of [
      ['Shoulder','Elbow',.183],['Elbow','Wrist',.154],['Wrist','Hand',.057],
      ['Shoulder','Hip',.29],['Hip','Knee',.248],['Knee','Ankle',.246],
      ['Ankle','Foot',.082],['Heel','Foot',.108],['Ankle','Heel',.043],
    ]) bones.push([side+a,side+b,length]);
    for (let pass=0;pass<30;pass++) {
      if (pass<16) for (const [key,target] of Object.entries(goals)) if (!locks.has(key)) {
        positions[key]=positions[key].map((x,i)=>M.lerp(x,target[i],.13*M.confidence(p[key])));
      }
      for (const [a,b,length] of bones) {
        const u=positions[a],v=positions[b],axis=delta(v,u),d=Math.hypot(...axis);
        const wa=locks.has(a)?0:1,wb=locks.has(b)?0:1;
        if (d<1e-5 || wa+wb===0) continue;
        const correction=(d-length*size)/(d*(wa+wb));
        for (let i=0;i<3;i++) { u[i]+=wa*axis[i]*correction; v[i]-=wb*axis[i]*correction; }
        u[2]=Math.max(.6,u[2]); v[2]=Math.max(.6,v[2]);
        // Planted contacts stay fixed, including on shallow holds.
        if (!wa) u[2]=locks.get(a)[2];
        if (!wb) v[2]=locks.get(b)[2];
      }
    }
    positions.pelvis=positions.leftHip.map((x,i)=>(x+positions.rightHip[i])/2);
    positions.neck=positions.leftShoulder.map((x,i)=>(x+positions.rightShoulder[i])/2);
    const landmarks=Object.fromEntries(Object.entries(positions).map(([key,[x,y,z]])=>
      [key,{x,y,z,confidence:M.confidence(p[key])}]));
    const centerOfMass=M.centerOfMass(landmarks);
    if (!centerOfMass) return null;
    const fitError=Math.sqrt(Object.keys(goals).reduce((sum,key)=>sum+Math.hypot(...delta(positions[key],goals[key]))**2,0)/Object.keys(goals).length);
    const boneError=Math.max(...bones.map(([a,b,length])=>Math.abs(Math.hypot(...delta(positions[a],positions[b]))-length*size)));
    const points=Object.fromEntries(Object.entries(landmarks).map(([key,{x,y}])=>[key,{x,y}]));
    const jointDepth=Object.fromEntries(Object.entries(landmarks).map(([key,{z}])=>[key,z]));
    return {points,depth:jointDepth,depthHint:depth,quality:M.clamp(quality-fitError/size*1.6,.05,.88),fitError,boneError,
      diagnostics:{centerOfMass}, contactLimbIds:[...locks.keys()]};
  }
  function estimate(pose, active, holds, motion, previous) {
    if (!pose || pose.quality<.51 || pose.boneError>4.5 || motion?.center?.confidence<.59) {
      return {status:'Pose confidence too low'};
    }
    if (motion?.speed==null || !motion.acceleration) return {status:'Motion unclear'};
    if (motion.speed>.15 || Math.hypot(motion.acceleration.x,motion.acceleration.y)>.8) return {status:'Moving too quickly for static forces'};
    if (active.length<2 || active.some(c=>c.confidence<.53 || !pose.contactLimbIds.includes(c.limb))) {
      return {status:'Contact confidence too low'};
    }
    const points={...pose.points};
    for (const limb of M.limbs) if (!active.some(c=>c.limb===limb)) delete points[limb];
    for (const c of active) points[c.limb]={...points[c.limb],profile:holds.get(c.id)?.profile};
    const balance=IK.supportForces({...pose,points},40,previous);
    const peak=Math.max(0,...balance.contacts.map(c=>magnitude(c.force)));
    const residual='Force '+balance.forceResidual.toFixed(2)+' BW · Torque '+balance.torqueResidual.toFixed(1)+' BW·in';
    if (balance.forceResidual>.13 || balance.torqueResidual>3.6 || peak>1.8) return {status:'No reliable static balance',residual};
    return { status:'Estimated static balance', residual, balance,
      confidence:Math.min(.8,pose.quality,...active.map(c=>c.confidence))*(1-balance.forceResidual),
    };
  }
  function build(frames,motion,calibration,contacts,holds,height) {
    let prior, depth;
    return frames.map((frame,i)=>{
      const active=M.contactAt(contacts,frame.t);
      const pose=fit(frame,calibration,active,holds,height,depth);
      depth=pose?.depthHint;
      const key=active.map(c=>c.limb+':'+c.id).sort().join(',');
      const forces=estimate(pose,active,holds,motion[i],prior?.key===key ? prior.balance.contacts : null);
      prior=forces.balance ? {key,balance:forces.balance} : null;
      return {t:frame.t,key,pose,forces};
    });
  }
  const api={fit,estimate,build};
  root.ClimbGenReconstruction=api;
  if (typeof module==='object' && module.exports) module.exports=api;
})(globalThis);
