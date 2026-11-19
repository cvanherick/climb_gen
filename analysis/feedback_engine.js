/* Coaching rules report observations and offer experiments. */
(function(root){
  const M=root.ClimbGenAnalysisModel || require('./analysis_model');
  function analyze(frames, measurements, contacts, calibrated, aspect=1) {
    const events=[];
    const add=(category,start,end,confidence,observation,suggestion)=>{
      if (events.some(e=>e.category===category && start<e.end+.4 && end>e.start-.4)) return;
      events.push({category,start,end,confidence,observation,suggestion});
    };
    const activeAt=i=>M.contactAt(contacts,frames[i].t);
    let lastSupport, swingStart, restStart, restQuality;
    for (let i=0;i<frames.length;i++) {
      const {t,image}=frames[i], row=measurements[i];
      if (!image || row.center?.confidence<.58 || !row.center) {
        lastSupport=swingStart=restStart=undefined; continue;
      }
      const active=activeAt(i);
      if (active.some(c=>c.limb.endsWith('Foot') && c.confidence>.55)) {
        if (swingStart && t-swingStart.time>=.22 && t-swingStart.time<=2.5 && swingStart.distance>.021) {
          add('Possible foot cut',swingStart.time,t,swingStart.quality,
            'Both feet appear to come off while at least one hand remains on.',
            'Try keeping pressure through the toes and bringing your hips closer before the reach.');
        }
        lastSupport=t;
        swingStart=undefined;
      } else if (calibrated && t-(lastSupport??-5)<.32 && !swingStart && active.some(c=>c.limb.endsWith('Hand') && c.confidence>.55)) {
        swingStart={time:t,left:image.leftFoot,right:image.rightFoot,distance:0,quality:.7};
      }
      if (swingStart) {
        const q=Math.min(M.confidence(image.leftFoot),M.confidence(image.rightFoot));
        if (q<.54 || !active.some(c=>c.limb.endsWith('Hand')) || t-swingStart.time>2.5) swingStart=undefined;
        else {
          const distance=side=>Math.hypot((image[side+'Foot'].x-swingStart[side].x)*aspect,image[side+'Foot'].y-swingStart[side].y);
          swingStart.distance=Math.max(swingStart.distance,distance('left'),distance('right'));
          swingStart.quality=Math.min(swingStart.quality,q);
        }
      }
      if (active.length>=2 && row.speed!=null && row.speed<.025 && active.some(c=>c.limb.endsWith('Hand'))) {
        restStart??=t; restQuality=Math.min(restQuality??.75,row.center.confidence);
      } else {
        if (restStart!=null && t-restStart>=3.75) add('Long pause',restStart,t,restQuality,
          'Your body position stays nearly still for several seconds.',
          'If you were deciding between holds, rehearse the next grip and foot placement before starting.');
        restStart=restQuality=undefined;
      }
      const past=measurements[Math.max(0,i-6)];
      if (row.pelvis && past.pelvis && t-past.t>.38 && row.speed>.13 &&
          Math.abs(row.pelvis.x-past.pelvis.x)*aspect>.10) {
        add('Lateral hip swing',past.t,t,Math.min(.78,row.center.confidence),
          'Your hips move sideways quickly in the image.',
          'Compare the move with a deliberate hip turn and a more stable opposite foot.');
      }
      if (row.acceleration && row.speed>.12 && Math.hypot(row.acceleration.x*aspect,row.acceleration.y)>.85) {
        add('Abrupt COM change',Math.max(0,t-.18),t+.18,Math.min(.72,row.center.confidence),
          'The projected center of mass changes speed abruptly.',
          'Compare this attempt with a smoother weight shift before releasing the moving limb.');
      }
    }
    for (const limb of M.limbs) {
      const sequence=contacts.filter(c=>c.limb===limb && c.confidence>=.55);
      for (let i=1;i<sequence.length;i++) {
        const a=sequence[i-1],b=sequence[i],c=sequence[i+1];
        if (a.id===b.id && b.start-a.end>.09 && b.start-a.end<.65 && limb.endsWith('Hand')) {
          add('Possible regrip',a.end,b.start,Math.min(.71,a.confidence,b.confidence),
            'The same hand loses and regains its estimated contact on this hold.',
            'Compare where your fingers arrive with where they settle.');
        }
        if (c && c.id===a.id && b.id!==a.id && c.start-a.end<2.5) {
          add('Contact reversal',a.end,c.start,Math.min(.74,a.confidence,b.confidence,c.confidence),
            'This limb returns to its earlier hold after an intermediate placement.',
            'Try planning the intermediate placement from the start. Review the footage to see whether it was deliberate.');
        }
      }
      for (let i=3;i<sequence.length;i++) {
        const recent=sequence.slice(i-3,i+1);
        if (recent.at(-1).start-recent[0].start>2.8) continue;
        const repeated=recent[0].id===recent[2].id && recent[1].id===recent[3].id;
        add(repeated?'Repeated contact pattern':'Rapid contact adjustments',recent[0].start,recent.at(-1).start,
          Math.min(.75,...recent.map(c=>c.confidence)),
          repeated?'The same two estimated placements alternate twice.':'This limb changes or re-establishes contact several times in a short window.',
          'Review what changed between placements and try a more deliberate first contact.');
      }
    }
    return events.sort((a,b)=>a.start-b.start).slice(0,60);
  }
  root.ClimbGenFeedback={analyze};
  if(typeof module==='object' && module.exports) module.exports={analyze};
})(globalThis);
