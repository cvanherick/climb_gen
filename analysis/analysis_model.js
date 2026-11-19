/* Timestamped pose, calibration-derived contacts, and motion observations. */
(function (root) {
  const { lowerBound } = root.ClimbGenVideo || require('./video_player');
  const limbs = Object.keys({ leftHand:0, rightHand:0, leftFoot:0, rightFoot:0 });
  const joints = {
    head:0, leftShoulder:11,rightShoulder:12,leftElbow:13,rightElbow:14,leftWrist:15,rightWrist:16,
    leftHip:23,rightHip:24,leftKnee:25,rightKnee:26,leftAnkle:27,rightAnkle:28,leftHeel:29,rightHeel:30,
    leftFoot:31,rightFoot:32,
  };
  const poseKeys = [...Object.keys(joints),'leftHand','rightHand','pelvis','neck'];
  const links = Object.keys(joints).filter(key => key.endsWith('Shoulder')).flatMap(shoulder => {
    const side = shoulder.slice(0,-8);
    return [['Shoulder','Elbow'],['Elbow','Wrist'],['Wrist','Hand'],['Shoulder','Hip'],
      ['Hip','Knee'],['Knee','Ankle'],['Ankle','Foot'],['Ankle','Heel'],['Heel','Foot']].map(pair=>pair.map(key=>side+key));
  }).concat([['leftShoulder','rightShoulder'],['leftHip','rightHip'],['head','neck']]);
  const confidence = p => p?.confidence ?? p?.visibility ?? 0;
  const clamp = (x, a, b) => Math.max(a,Math.min(b,x));
  const lerp = (a,b,t) => a+(b-a)*t;
  const mix = (a,b,t) => a && b ? {x:lerp(a.x,b.x,t),y:lerp(a.y,b.y,t),z:lerp(a.z??0,b.z??0,t),
    confidence:Math.min(confidence(a),confidence(b))} : null;
  function named(landmarks) {
    if (!landmarks || landmarks.length<33) return null;
    const out = {};
    for (const [key,index] of Object.entries(joints)) out[key] = landmarks[index];
    for (const [side,wrist,pinky,index] of [['left',15,17,19],['right',16,18,20]]) {
      const fingers = mix(landmarks[pinky],landmarks[index],.5);
      out[side+'Hand'] = mix(landmarks[wrist],fingers,.72);
    }
    out.pelvis = mix(out.leftHip,out.rightHip,.5);
    out.neck = mix(out.leftShoulder,out.rightShoulder,.5);
    return out;
  }
  function smooth(raw) {
    const converted = raw.map(({t,image,world})=>({ t,image:named(image),world:named(world) }));
    return converted.map((frame,i)=> {
      if (!frame.image) return frame;
      const output = { t:frame.t };
      for (const space of ['image','world']) {
        if (!frame[space]) {output[space]=null;continue;}
        let first=i,last=i;
        while(first>Math.max(0,i-2) && converted[first-1][space] && frame.t-converted[first-1].t<=.18) first--;
        while(last<Math.min(converted.length-1,i+2) && converted[last+1][space] && converted[last+1].t-frame.t<=.18) last++;
        output[space] = Object.fromEntries(Object.entries(frame[space]).map(([key,p])=>{
          const total = {x:0,y:0,z:0};
          let sum=0;
          for (let j=first;j<=last;j++) {
            const other=converted[j][space]?.[key], dt=Math.abs(converted[j].t-frame.t);
            if (!other || dt>.18) continue;
            const weight=Math.exp(-.5*(dt/.072)**2)*Math.max(.02,confidence(other));
            for (const axis of ['x','y','z']) total[axis]+=(other[axis]??0)*weight;
            sum+=weight;
          }
          return [key,{x:total.x/sum,y:total.y/sum,z:total.z/sum,confidence:confidence(p)}];
        }));
      }
      return output;
    });
  }
  function sample(frames,t) {
    const index=lowerBound(frames,t,f=>f.t), a=frames[index-1], b=frames[index];
    if (b && Math.abs(t-b.t)<.001) return {...b,kind:'observed'};
    if (!b && a && t-a.t<=.12) return {...a,kind:'nearest'};
    if (!a && b && b.t-t<=.12) return {...b,kind:'nearest'};
    if (!a?.image || !b?.image || b.t-a.t>.21) return null;
    const amount=(t-a.t)/(b.t-a.t);
    const blend = (u,v) => u && v && Object.fromEntries(Object.keys(u).map(key=>[key,mix(u[key],v[key],amount)]));
    return {t,image:blend(a.image,b.image),world:blend(a.world,b.world),kind:'interpolated'};
  }
  function centerOfMass(points) {
    if (!points) return null;
    const segments=[['pelvis','neck',.497,.56],['head','head',.081,.5]];
    for (const side of ['left','right']) for (const [a,b,m,f] of [
      ['Shoulder','Elbow',.028,.436],['Elbow','Wrist',.016,.43],['Wrist','Hand',.006,.5],
      ['Hip','Knee',.1,.433],['Knee','Ankle',.0465,.433],['Heel','Foot',.0145,.5],
    ]) segments.push([side+a,side+b,m,f]);
    let mass=0, quality=0;
    const center={x:0,y:0,z:0};
    for (const [a,b,m,f] of segments) {
      const p=mix(points[a],points[b],f);
      if (!p || p.confidence<.28) continue;
      for (const key of ['x','y','z']) center[key]+=p[key]*m;
      mass+=m; quality+=m*p.confidence;
    }
    if (mass<.65) return null;
    return {x:center.x/mass,y:center.y/mass,z:center.z/mass,confidence:quality};
  }
  function angles(points) {
    function angle(a,b,c) {
      const u=points[a], v=points[b], w=points[c];
      if (Math.min(confidence(u),confidence(v),confidence(w))<.45) return null;
      const useZ = u.z != null && v.z != null && w.z != null;
      const delta = p => [p.x-v.x,p.y-v.y,useZ?p.z-v.z:0];
      const p=delta(u), q=delta(w);
      const denom=Math.hypot(...p)*Math.hypot(...q);
      return denom<1e-6 ? null : Math.acos(clamp(p.reduce((s,x,i)=>s+x*q[i],0)/denom,-1,1))*180/Math.PI;
    }
    return Object.fromEntries(['left','right'].flatMap(side=>[
      [side+'Elbow',angle(side+'Shoulder',side+'Elbow',side+'Wrist')],
      [side+'Knee',angle(side+'Hip',side+'Knee',side+'Ankle')],
    ]));
  }
  function motion(frames,aspect=1) {
    const entries=frames.map(f=>({ t:f.t, center:centerOfMass(f.image), pelvis:f.image?.pelvis ?? null,
      angles:f.world ? angles(f.world) : null }));
    const derivative=(i,key,radius)=> {
      if (!entries[i][key] || entries[i].center?.confidence<.55) return null;
      let first=i,last=i;
      const continuous=(a,b)=>entries[a][key] && entries[a].center?.confidence>=.55 && Math.abs(entries[a].t-entries[b].t)<=.21;
      while(first>Math.max(0,i-radius) && continuous(first-1,first)) first--;
      while(last<Math.min(entries.length-1,i+radius) && continuous(last+1,last)) last++;
      const a=entries[first],b=entries[last];
      const dt=b.t-a.t;
      if (dt<.075 || dt>.66 || (key==='velocity' && last-first<2)) return null;
      return { x:(b[key].x-a[key].x)/dt, y:(b[key].y-a[key].y)/dt };
    };
    for (let i=0;i<entries.length;i++) entries[i].velocity=derivative(i,'center',2);
    for (let i=0;i<entries.length;i++) {
      const row=entries[i];
      row.acceleration=derivative(i,'velocity',3);
      row.speed=row.velocity && Math.hypot(row.velocity.x*aspect,row.velocity.y);
    }
    return entries;
  }
  function motionAt(entries,frame,t,aspect=1) {
    if (!frame?.image) return null;
    const center=centerOfMass(frame.image);
    if (!center) return null;
    const index=lowerBound(entries,t,f=>f.t);
    const a=entries[index-1],b=entries[index];
    const exact=[a,b].find(row=>row && Math.abs(row.t-t)<.001);
    const interpolate=(u,v)=>{
      if (!u || !v || !a.center || !b.center || b.t-a.t>.21) return null;
      const amount=(t-a.t)/(b.t-a.t);
      return {x:lerp(u.x,v.x,amount),y:lerp(u.y,v.y,amount)};
    };
    const velocity=exact ? exact.velocity : interpolate(a?.velocity,b?.velocity);
    const acceleration=exact ? exact.acceleration : interpolate(a?.acceleration,b?.acceleration);
    return {center,velocity,acceleration,speed:velocity && Math.hypot(velocity.x*aspect,velocity.y),
      angles:frame.world ? angles(frame.world) : null};
  }
  function detectContacts(frames,calibration,holds,geometry={},duration=frames.at(-1)?.t??0) {
    if (!calibration) return [];
    const candidates=[...holds].map(([id,h])=>{
      const outline=geometry.holds?.[id]?.outline;
      const radius=outline ? Math.max(...outline.map(([x,y])=>Math.hypot(x,y))) : 2;
      return {id:String(id),x:h.x,y:h.y,radius};
    });
    const intervals=[];
    for (const limb of limbs) {
      let pending=null, active=null, previous=null;
      const close=() => {
        if (active && active.end-active.start>=.15) {
          intervals.push({limb,id:active.id,start:active.start,end:active.end,
            confidence:clamp(active.sum/active.count,.1,.89),source:'automatic'});
        }
        active=null;
      };
      for (const { t,image } of frames) {
        const point=image?.[limb];
        const usable=confidence(point)>=.38;
        const p=usable ? calibration.unproject(point.x,point.y) : null;
        const velocity=p && previous && t-previous.t<=.22 ? Math.hypot(p.x-previous.x,p.y-previous.y)/(t-previous.t) : 0;
        previous=p ? {...p,t} : null;
        let best=null,bestScore=Infinity;
        if (p && velocity<34) for (const candidate of candidates) {
          const distance=Math.hypot(p.x-candidate.x,p.y-candidate.y)/(2+candidate.radius);
          if (distance<=1 && distance<bestScore) { best=candidate; bestScore=distance; }
        }
        if (active && p && velocity<44) {
          const distance=Math.hypot(p.x-active.hold.x,p.y-active.hold.y)/(2+active.hold.radius);
          // Keep the current hold through small bounces, but require a
          // clearer match before a nearby hold can displace it.
          if (distance<1.12 && (!best || best.id===active.id || bestScore+.27>=distance)) {
            active.end=t; active.sum+=confidence(point)*(1-.48*distance); active.count++;
            pending=null;
            continue;
          }
        }
        if (active && t-active.end>.16) close();
        if (!best) { pending=null; continue; }
        if (!pending || pending.id!==best.id || t-pending.end>.17) pending={id:best.id,hold:best,start:t,end:t,sum:0,count:0};
        pending.end=t; pending.sum+=confidence(point)*(1-.48*bestScore); pending.count++;
        if (t-pending.start>=.145 && pending.count>=3) {
          if (active) close();
          active=pending; pending=null;
        }
      }
      if (active && duration-active.end<.15) active.end=duration;
      close();
    }
    return intervals.sort((a,b)=>a.start-b.start);
  }
  function editContacts(intervals, edit) {
    const {limb,start,end,id}=edit;
    if (!limbs.includes(limb) || !Number.isFinite(start) || !Number.isFinite(end) || start<0 || end<=start) {
      throw new Error('Enter a valid contact start and end time.');
    }
    const result=[];
    for (const c of intervals) {
      if (c.limb!==limb || c.end<=start || c.start>=end) result.push(c);
      else {
        if (c.start<start) result.push({...c,end:start});
        if (c.end>end) result.push({...c,start:end});
      }
    }
    if (id!=null) result.push({limb,id:String(id),start,end,confidence:1,source:'manual'});
    return result.sort((a,b)=>a.start-b.start);
  }
  function contactAt(intervals,t) {
    return intervals.filter(c=>c.start<=t && t<c.end);
  }
  function contactsToReview(intervals) {
    return intervals.filter(c=>c.source==='automatic' && c.confidence<.65);
  }
  function contactStances(intervals,duration) {
    const changes=new Map([[0,[]],[duration,[]]]);
    for(const c of intervals) for(const [time,start] of [[c.start,true],[c.end,false]]) {
      if(!changes.has(time)) changes.set(time,[]);
      changes.get(time).push({c,start});
    }
    const times=[...changes.keys()].sort((a,b)=>a-b), active=new Map(), stances=[];
    for(let i=0;i<times.length-1;i++){
      const start=times[i],end=times[i+1];
      const edits=changes.get(start);
      for(const edit of edits) if(!edit.start) active.delete(edit.c.limb);
      for(const edit of edits) if(edit.start) active.set(edit.c.limb,edit.c.id);
      const contacts=Object.fromEntries(limbs.filter(limb=>active.has(limb)).map(limb=>[limb,active.get(limb)]));
      const key=JSON.stringify(contacts);
      const previous=stances.at(-1);
      if(previous?.key===key) previous.end=end;
      else stances.push({start,end,contacts,key});
    }
    return stances.map(({key,...stance})=>stance);
  }
  const api={limbs,poseKeys,links,confidence,smooth,sample,centerOfMass,motion,motionAt,detectContacts,editContacts,contactAt,contactsToReview,contactStances,clamp,lerp};
  root.ClimbGenAnalysisModel=api;
  if (typeof module==='object' && module.exports) module.exports=api;
})(globalThis);
