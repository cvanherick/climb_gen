/* Dashboard controller. All panels use the same selected media timestamp. */
(function (root) {
  const M=root.ClimbGenAnalysisModel, V=root.ClimbGenVideo, R=root.ClimbGenReconstruction;
  const wire='leftHand rightHand leftFoot rightFoot'.split(' ');
  const label={leftHand:'Left hand',rightHand:'Right hand',leftFoot:'Left foot',rightFoot:'Right foot'};
  const hand='#67e8f9', foot='#e7a5ff', gold='#ffc761';
  const color=limb=>limb.endsWith('Foot') ? foot : hand;
  const $=suffix=>document.getElementById('analysis-'+suffix);
  function init(holdMap,geometry) {
    const video=$('video'), overlay=$('overlay'), flat=$('board-flat'), stage=$('stage'), canvas=$('board');
    const ctx=overlay.getContext('2d'), flatCtx=flat.getContext('2d');
    const holds=root.ClimbGenBoard3D.contactPlacements(holdMap,geometry);
    let session=null, url=null, controller=null, view3D, webglUnavailable=false, visible=false;
    let calibration=null, corners=[], draft=null, preview=null, metadata=null, resultsRevision=0, sampleTimes=[];
    let stepRequest=0, betaJob=null;
    let activeKey='', activeRoute=null, hoveredHold=null;
    const player=V.attach(video,render);
    const getHoldList=()=>[...holds.keys()].map(String).sort((a,b)=>Number(a)-Number(b));
    for(const id of getHoldList()) $('edit-hold').add(new Option('#'+id,id));
    function setStatus(message) { $('status').textContent=message; }
    function syncMode() {
      const useFlat=webglUnavailable || $('flat-toggle').getAttribute('aria-pressed')==='true';
      flat.hidden=!useFlat; canvas.hidden=useFlat;
      $('flat-toggle').textContent=useFlat?'3D board':'2D board';
      $('flat-toggle').disabled=webglUnavailable;
      for(const button of $('camera').querySelectorAll('[data-camera]')) button.disabled=useFlat;
    }
    function open() {
      visible=true;
      if (!view3D && !webglUnavailable) {
        try { view3D=root.ClimbGenBoard3D.create(canvas,holdMap,geometry); }
        catch { webglUnavailable=true; syncMode(); player.refresh(); }
      }
      player.refresh();
    }
    function close() {
      visible=false;
      video.pause();
      player.cancelStep();
      betaJob?.abort();
    }
    function setBusy(value) {
      $('run').disabled=value || !metadata;
      $('cancel').hidden=!value; $('progress').hidden=!value;
      $('height').disabled=value; $('weight').disabled=value;
    }
    function dimensions() {
      if (!metadata) return;
      const aspect=metadata.width/metadata.height;
      stage.style.aspectRatio=String(aspect);
      stage.style.setProperty('--video-width',Math.min(100,aspect*62)+'vh');
      const factor=Math.min(1,1280/Math.max(metadata.width,metadata.height));
      overlay.width=Math.round(metadata.width*factor);
      overlay.height=Math.round(metadata.height*factor);
    }
    $('file').addEventListener('change',()=>{
      const file=$('file').files[0];
      if (!file) return;
      controller?.abort(); controller=null;
      betaJob?.abort();
      resultsRevision++;
      video.pause();
      if(url) URL.revokeObjectURL(url);
      metadata=null; session=null; calibration=null; corners=[]; draft=null; preview=null; hoveredHold=null;
      sampleTimes=[]; $('export').disabled=true; $('beta').disabled=true;
      $('undo-contact').disabled=true;
      $('beta-result').textContent='';
      setBusy(false); player.reset(); calibrationUI(); timeline(); feedback();
      $('workspace').hidden=true;
      setStatus('Opening video…');
      url=URL.createObjectURL(file);
      video.src=url;
      video.load();
    });
    video.addEventListener('loadedmetadata',()=>{
      if (!Number.isFinite(video.duration) || video.duration<=0 || !video.videoWidth) {
        setStatus('Choose a video with a finite duration and an image track.');
        return;
      }
      metadata={name:$('file').files[0]?.name,width:video.videoWidth,height:video.videoHeight,duration:video.duration};
      $('timebar').max=String(video.duration);
      $('workspace').hidden=false;
      setBusy(false); dimensions();
      $('edit-end').max=String(video.duration);
      setStatus('Video ready. You can mark the board now or after tracking.');
      editDefaults(); player.refresh();
    });
    video.addEventListener('loadeddata',()=>player.refresh());
    video.addEventListener('error',()=>setStatus('This browser could not open the video. Try an H.264 MP4 or a WebM file.'));
    $('form').addEventListener('submit',async event=>{
      event.preventDefault();
      if (!metadata || controller) return;
      const analysis=new AbortController();
      controller=analysis;
      const source = document.createElement('video');
      source.className='analysis-decoder';
      source.muted=true; source.playsInline=true; source.preload='auto';
      const clip={...metadata};
      const height=$('height').valueAsNumber, weight=$('weight').valueAsNumber;
      setBusy(true); video.pause(); $('progress').value=0;
      setStatus('Loading the local pose tracker…');
      document.body.append(source);
      try {
        await new Promise((resolve,reject)=>{
          const signal=analysis.signal;
          const done=()=>{ clearTimeout(timer); signal.removeEventListener('abort',abort); source.onloadeddata=source.onerror=null; };
          const abort=()=>{done();reject(new DOMException('Cancelled','AbortError'));};
          const fail=()=>{done();reject(new Error('The analysis decoder could not open this clip.'));};
          const timer=setTimeout(fail,12000);
          signal.addEventListener('abort',abort,{once:true});
          source.onloadeddata=()=>{done();resolve();}; source.onerror=fail;
          source.src=url;
        });
        let execution;
        const frames=await root.ClimbGenPoseTracker.analyze(source,analysis.signal,(count,fraction,backend)=>{
          if (controller!==analysis) return;
          execution=backend;
          $('progress').value=fraction;
          if(count===1 || count%6===0) setStatus('Tracking pose · '+Math.round(fraction*100)+'%');
        });
        analysis.signal.throwIfAborted();
        const smoothed=M.smooth(frames);
        if(!smoothed.some(f=>f.image)) throw new Error('No climber was detected. Try a brighter clip with the climber larger in frame.');
        session={ schemaVersion:1, board:{layout:'TB2 Mirror',sizeInches:[144,144],angleDeg:40},
          video:clip, climber:{heightCm:height,weightKg:Number.isFinite(weight)?weight:null},
          sampling:{targetFps:12,tracker:'MediaPipe Pose Landmarker Lite',execution}, frames:smoothed,
          edits:session?.edits ?? [] };
        const coverage=smoothed.filter(f=>f.image).length/smoothed.length;
        session.poseCoverage=coverage;
        sampleTimes=frames.map(f=>f.t);
        session.motion=M.motion(smoothed,clip.width/clip.height);
        rebuild();
        setStatus('Analysis ready · '+Math.round(coverage*100)+'% of samples detected a pose.');
      } catch(error) {
        if(controller===analysis) setStatus(error.name==='AbortError'?'Analysis cancelled.':error.message || 'Pose detection failed.');
      } finally {
        source.removeAttribute('src'); source.load(); source.remove();
        if(controller===analysis) { controller=null; setBusy(false); }
      }
    });
    for(const key of ['height','weight']) $(key).addEventListener('change',()=>{
      if(!session || !$(key).validity.valid) return;
      if(key==='height') {
        session.climber.heightCm=$('height').valueAsNumber;
        rebuild();
        setStatus('Climber height applied to the cached 3D fit.');
      } else {
        session.climber.weightKg=Number.isFinite($('weight').valueAsNumber) ? $('weight').valueAsNumber : null;
        setStatus('Climber weight updated for the analysis export.');
      }
    });
    $('cancel').addEventListener('click',()=>controller?.abort());
    $('play').addEventListener('click',()=>{
      if (video.paused) video.play().catch(()=>setStatus('Playback could not start at this speed.'));
      else video.pause();
    });
    for (const type of ['play','pause','ended']) video.addEventListener(type,()=>{ $('play').textContent=video.paused?'Play':'Pause'; });
    $('speed').addEventListener('change',()=>{
      try {
        video.playbackRate=Number($('speed').value);
        if (video.playbackRate!==Number($('speed').value)) throw new Error();
      } catch {
        $('speed').value=String(video.playbackRate);
        setStatus('This browser does not support the selected playback speed.');
      }
    });
    $('timebar').addEventListener('input',()=>player.seek($('timebar').valueAsNumber));
    for (const [id,direction] of [['prev',-1],['next',1]]) $(id).addEventListener('click',async()=>{
      const request=++stepRequest;
      const status=$('step-status');
      status.hidden=false;status.textContent='Finding frame…';
      $('prev').disabled=$('next').disabled=true;
      try { await player.step(direction,sampleTimes); }
      catch(error) { if(error.name!=='AbortError') setStatus('Could not step to that video frame.'); }
      finally {
        if(request===stepRequest) {
          $('prev').disabled=$('next').disabled=false;
          if(status.textContent==='Finding frame…') status.hidden=true;
        }
      }
    });
    $('fullscreen').addEventListener('click',async()=>{
      try {
        if (document.fullscreenElement) await document.exitFullscreen();
        else if(stage.requestFullscreen) await stage.requestFullscreen();
        else if(video.webkitEnterFullscreen) video.webkitEnterFullscreen();
      } catch { setStatus('Fullscreen is not available in this browser.'); }
    });
    for (const id of ['pose','com','trail','motion','holds','forces']) $('show-'+id).addEventListener('change',()=>player.refresh());
    $('force-side').addEventListener('change',()=>player.refresh());
    for (const button of $('camera').querySelectorAll('[data-camera]')) {
      button.addEventListener('click',()=>view3D?.preset(button.dataset.camera));
    }
    $('flat-toggle').addEventListener('click',()=>{
      const next=canvas.hidden?'false':'true';
      $('flat-toggle').setAttribute('aria-pressed',next);
      syncMode(); player.refresh();
    });
    canvas.addEventListener('webglcontextlost',event=>{
      event.preventDefault(); webglUnavailable=true; syncMode(); player.refresh();
    });
    function calibrationUI() {
      const names=['upper left','upper right','lower right','lower left'];
      $('calibration-status').textContent=draft?.length===4
        ? preview ? 'Check the projected holds. Select a corner and click its new location, or apply the alignment.'
          : 'Adjust the selected corner until the outline is clockwise and convex.'
        : draft?'Click the '+names[draft.length]+' corner of the full plywood face.':
        calibration?'Board aligned. Turn on Hold IDs to check the projection.':'Mark the corners of the full board face to identify contacts.';
      $('calibrate').textContent=calibration?'Correct board corners':'Mark board corners';
      $('calibrate').disabled=Boolean(draft);
      $('corner-apply').hidden=!draft;
      $('corner-apply').disabled=!preview;
      $('corner-undo').hidden=!draft; $('corner-undo').disabled=!draft?.length;
      $('corner-cancel').hidden=!draft;
      $('corner-reset').hidden=!calibration || Boolean(draft);
      overlay.classList.toggle('marking',Boolean(draft));
    }
    let selectedCorner=null;
    function refreshDraft() {
      preview=null;
      try {
        if(draft?.length===4) preview=root.ClimbGenCalibration.calibrate(draft,metadata.width/metadata.height);
      } catch { /* Keep invalid candidates editable. */ }
      calibrationUI();player.refresh();
    }
    $('calibrate').addEventListener('click',()=>{
      video.pause();player.cancelStep();draft=corners.slice();selectedCorner=null;refreshDraft();
    });
    $('corner-undo').addEventListener('click',()=>{draft?.pop();selectedCorner=null;refreshDraft();});
    $('corner-cancel').addEventListener('click',()=>{draft=null;selectedCorner=null;refreshDraft();});
    $('corner-apply').addEventListener('click',()=>{
      if(!preview)return;
      calibration=preview;corners=draft;draft=null;selectedCorner=null;
      $('show-holds').checked=true;
      refreshDraft();rebuild();
    });
    $('corner-reset').addEventListener('click',()=>{
      calibration=null;corners=[];hoveredHold=null;
      calibrationUI();rebuild();player.refresh();
    });
    function imagePoint(event) {
      const bounds=overlay.getBoundingClientRect();
      const scale=Math.min(bounds.width/metadata.width,bounds.height/metadata.height);
      const width=metadata.width*scale,height=metadata.height*scale;
      const click={x:(event.clientX-bounds.left-(bounds.width-width)/2)/width,
        y:(event.clientY-bounds.top-(bounds.height-height)/2)/height};
      return click.x<0 || click.x>1 || click.y<0 || click.y>1 ? null : click;
    }
    function nearestHold(click) {
      const p=calibration.unproject(click.x,click.y);
      return [...holds].reduce((best,[id,h])=>{
        const d=Math.hypot(p.x-h.x,p.y-h.y);
        return d<best.d ? {id,d}:best;
      },{d:5}).id;
    }
    overlay.addEventListener('pointermove',event=>{
      if(!metadata || !calibration || draft || !$('show-holds').checked)return;
      const p=imagePoint(event);
      const id=p && nearestHold(p);
      if(id!==hoveredHold){hoveredHold=id;player.refresh();}
    });
    overlay.addEventListener('pointerleave',()=>{
      if(hoveredHold){hoveredHold=null;player.refresh();}
    });
    overlay.addEventListener('click',event=>{
      if(!metadata)return;
      const click=imagePoint(event);
      if(!click)return;
      if(draft){
        if(draft.length<4) draft.push(click);
        else if(selectedCorner!=null) {draft[selectedCorner]=click;selectedCorner=null;}
        else {
          // Select the nearest handle in screen space, regardless of video aspect.
          selectedCorner=draft.reduce((best,p,i)=>{
            const d=Math.hypot((p.x-click.x)*overlay.width,(p.y-click.y)*overlay.height);
            return d<best.d?{i,d}:best;
          },{i:null,d:Infinity}).i;
        }
        refreshDraft();
      } else if(calibration && $('show-holds').checked){
        const id=nearestHold(click);
        if(id) { $('contact-form').closest('details').open=true; editDefaults(); $('edit-hold').value=id; }
      }
    });
    function rebuild() {
      if (!session) return;
      betaJob?.abort();
      const frames=session.frames;
      session.calibration=calibration ? {corners,estimatedFocalLength:calibration.focalKnown} : null;
      let contacts=M.detectContacts(frames,calibration,holds,geometry,metadata.duration);
      if(calibration) for(const edit of session.edits) contacts=M.editContacts(contacts,edit);
      session.contacts=contacts;
      session.stances=M.contactStances(contacts,metadata.duration);
      session.reconstruction=calibration ? R.build(frames,session.motion,calibration,contacts,holds,session.climber.heightCm) : [];
      session.events=root.ClimbGenFeedback.analyze(frames,session.motion,contacts,!!calibration,metadata.width/metadata.height)
        .map(e=>({...e,end:Math.min(e.end,metadata.duration)}));
      resultsRevision++;
      $('export').disabled=false; $('beta').disabled=contacts.length<3;
      $('undo-contact').disabled=!session.edits.length;
      $('beta-result').textContent='';
      timeline(); feedback(); editDefaults(); player.refresh();
    }
    function editDefaults(c) {
      if(!metadata) return;
      const t=player.time;
      c??=session?.contacts?.find(c=>c.limb===$('edit-limb').value && c.start<=t && t<c.end);
      if(c) $('edit-limb').value=c.limb;
      const from=c?.start??Math.min(t,Math.max(0,metadata.duration-.25));
      $('edit-start').value=from.toFixed(3);
      $('edit-end').value=Math.min(metadata.duration,c?.end??from+.6).toFixed(3);
      $('edit-hold').value=c?.id??'';
    }
    $('edit-limb').addEventListener('change',()=>editDefaults());
    $('contact-form').addEventListener('submit',event=>{
      event.preventDefault();
      if(!session || !calibration) { setStatus('Track the climber and mark the four board corners first.'); return; }
      const edit={limb:$('edit-limb').value,id:$('edit-hold').value||null,start:$('edit-start').valueAsNumber,
        end:Math.min(metadata.duration,$('edit-end').valueAsNumber)};
      try {
        if(edit.id && !holds.has(edit.id)) throw new Error('Select a hold from this board.');
        M.editContacts(session.contacts,edit);
        session.edits.push(edit);
        rebuild(); player.seek(edit.start);
        setStatus('Contact correction applied.');
      } catch(error) { setStatus(error.message); }
    });
    $('undo-contact').addEventListener('click',()=>{
      if(!session?.edits.length)return;
      session.edits.pop();
      rebuild();
      setStatus('Last contact correction undone.');
    });
    $('export').addEventListener('click',()=>{
      if (!session) return;
      const href=URL.createObjectURL(new Blob([JSON.stringify(session)],{type:'application/json'}));
      const a=document.createElement('a'); a.href=href; a.download='climbgen-analysis-v1.json'; a.click();
      setTimeout(()=>URL.revokeObjectURL(href),1000);
    });
    $('beta').addEventListener('click',async()=>{
      const found=session?.contacts?.filter(c=>c.confidence>=.6)??[];
      const hands=found.filter(c=>c.limb.endsWith('Hand'));
      if(!hands.length) { $('beta-result').textContent='Confirm hand placements first.';return; }
      const first=hands[0];
      const other=hands.find(c=>c.limb!==first.limb && c.start<first.end && c.start-first.start<=.35);
      const starts=new Set(other ? [first.id,other.id] : [first.id]);
      const finish=hands.at(-1).id;
      const role=new Map(found.map(c=>[c.id,8]));
      for(const c of hands) role.set(c.id,6);
      for(const id of starts) role.set(id,5);
      if(starts.has(finish)) { $('beta-result').textContent='Confirm an observed finish on a different hold.';return; }
      role.set(finish,7);
      if(![...role.values()].includes(6) || ![...role.values()].includes(8)) {
        $('beta-result').textContent='Confirm an intermediate handhold and at least one separate foothold.';
        return;
      }
      betaJob?.abort();
      const job=new AbortController();
      betaJob=job;
      $('beta').disabled=true;
      $('beta-result').textContent='Searching for model-generated beta…';
      try {
        const result=await root.ClimbGenPlanner.planAsync(
          {holds:[...role].map(([id,role])=>({id,role}))},holdMap,
          {maxExpanded:550,beamWidth:30,maxDepth:32,signal:job.signal}
        );
        if(!job.signal.aborted && betaJob===job) {
          $('beta-result').textContent=result.ok?'Model-generated option · '+result.steps.map(s=>label[s.limb]+' #'+s.id).join(' → '):
            'No alternative was found for those estimated holds. Review the contact sequence and try again.';
        }
      } catch {
        if(!job.signal.aborted) $('beta-result').textContent='An alternative could not be computed for these contacts.';
      } finally {
        if(betaJob===job) {
          betaJob=null;
          $('beta').disabled=(session?.contacts?.length??0)<3;
          if(job.signal.aborted) $('beta-result').textContent='';
        }
      }
    });
    function seekButton(text,time) {
      const button=document.createElement('button');
      button.type='button'; button.className='view-button'; button.textContent=text;
      button.addEventListener('click',()=>player.seek(Math.min(video.duration,time+.001)));
      return button;
    }
    function timeline() {
      const target=$('markers');
      target.replaceChildren();
      if(!session) return;
      const lanes=wire.map(limb=>[label[limb],session.contacts.filter(c=>c.limb===limb)]);
      lanes.push(['Technique',session.events??[]]);
      for (const [name,events] of lanes) {
        const lane=document.createElement('div');
        lane.className='analysis-lane';
        const heading=document.createElement('span');
        heading.textContent=name;
        const track=document.createElement('div'); track.className='analysis-track';
        track.setAttribute('role','group'); track.setAttribute('aria-label',name+' markers');
        for (const c of events) {
          const title=(c.category??label[c.limb]+' #'+c.id)+' · '+c.start.toFixed(2)+'–'+c.end.toFixed(2)+' s'+
            (c.source==='manual'?' · Corrected':'');
          const button=seekButton('',c.limb?c.start+Math.min(.045,(c.end-c.start)/2):c.start);
          button.className=c.limb?'analysis-tick analysis-contact-tick':'analysis-tick';
          button.title=title; button.setAttribute('aria-label',title);
          button.style.left=(c.start/video.duration*100)+'%';
          button.style.setProperty('--marker-color',c.limb?color(c.limb):gold);
          if(c.limb) {
            button.style.width=((c.end-c.start)/video.duration*100)+'%';
            button.classList.toggle('manual',c.source==='manual');
            button.addEventListener('click',()=>{$('contact-form').closest('details').open=true;editDefaults(c);});
          }
          track.append(button);
        }
        lane.append(heading,track);
        target.append(lane);
      }
      const trace=$('force-trace');
      if(!trace) return;
      trace.hidden=!session.reconstruction?.some(f=>f.forces.balance);
      const pen=trace.getContext('2d'), w=trace.width,h=trace.height;
      pen.clearRect(0,0,w,h);
      for(const [i,limb] of wire.entries()){
        let end=null;
        pen.beginPath();pen.strokeStyle=[hand,'#419afb',foot,'#b773e3'][i];pen.lineWidth=1.4;
        for(const f of session.reconstruction){
          const forces=f.forces.balance?.contacts;
          if (!forces){end=null;continue;}
          const contact=forces.find(c=>c.limb===limb);
          const force=contact?.force;
          const x=w*f.t/video.duration;
          const y=h-2-(h-4)*(force?Math.hypot(force.x,force.y,force.z)/1.8:0);
          const current=f.key.split(',').find(key=>key.startsWith(limb+':'));
          if(!current || end!==current) pen.moveTo(x,y);
          else pen.lineTo(x,y);
          end=current;
        }
        pen.stroke();
      }
    }
    function feedback() {
      const list=$('feedback');
      list.replaceChildren();
      for(const event of session?.events??[]) {
        const li=document.createElement('li');
        const detail=document.createElement('p');
        detail.textContent=event.observation+' '+event.suggestion+' ('+Math.round(event.confidence*100)+'% model confidence)';
        li.append(seekButton(event.start.toFixed(2)+' s · '+event.category,event.start),detail);
        list.append(li);
      }
      if(!list.childElementCount) {
        const item=document.createElement('li');
        item.textContent=session?'No events met the confidence thresholds.':'Analyze a video to find moments to review.';
        list.append(item);
      }
    }
    function drawVideo(frame,movement,active,t) {
      const w=overlay.width,h=overlay.height;
      ctx.clearRect(0,0,w,h);
      const at=p=>[p.x*w,p.y*h];
      function line(a,b,stroke,width=2,dash=[]) {
        ctx.strokeStyle=stroke;ctx.lineWidth=width;ctx.setLineDash(dash);
        ctx.beginPath();ctx.moveTo(...at(a));ctx.lineTo(...at(b));ctx.stroke();ctx.setLineDash([]);
      }
      function dot(p,r,fill) {
        ctx.fillStyle=fill;ctx.beginPath();ctx.arc(...at(p),r,0,2*Math.PI);ctx.fill();
      }
      function idAt(id,p) {
        ctx.font='10px monospace';ctx.fillStyle='#fff';ctx.strokeStyle='#142021';ctx.lineWidth=2.5;
        ctx.strokeText(id,p.x*w+4,p.y*h-2);ctx.fillText(id,p.x*w+4,p.y*h-2);
      }
      const projectedBoard=draft?preview:calibration;
      if(projectedBoard){
        const ids=$('show-holds').checked || Boolean(preview);
        if(ids) for(const [id,h] of holds){
          const p=projectedBoard.project(h.x,h.y);
          dot(p,2,'#a7e687bb');
          if(id===hoveredHold || id===$('edit-hold').value) idAt(id,p);
        }
        if(!draft) for(const c of active) {
          const h=holds.get(c.id);
          if(!h)continue;
          const p=calibration.project(h.x,h.y);
          dot(p,7,color(c.limb));
          dot(p,4,'#162021');
          if(ids) idAt(c.id,p);
        }
      }
      if (draft) draft.forEach((p,i)=>{
        dot(p,i===selectedCorner?10:7,i===selectedCorner?gold:'#b8ef66'); idAt(String(i+1),p);
        if(i) line(draft[i-1],p,'#b8ef66',3,[6,4]);
        if(i===3) line(p,draft[0],'#b8ef66',3,[6,4]);
      });
      if(frame?.image && $('show-pose').checked){
        for(const [a,b] of M.links){
          const p=frame.image[a],q=frame.image[b],certainty=Math.min(M.confidence(p),M.confidence(q));
          if(!p || !q || certainty<.19)continue;
          line(p,q,certainty<.5?'#f5a972ac':'#e8fbef',2.1,certainty<.5?[5,4]:[]);
        }
        for(const point of Object.values(frame.image)){
          const certainty=M.confidence(point);
          if(certainty>=.19) dot(point,3,certainty<.5?'#f5a972ac':'#baf884');
        }
      }
      const center=movement?.center;
      if(!center || !frame?.image)return;
      if($('show-trail').checked){
        let last=null;
        const data=session.motion, index=V.lowerBound(data, t-2,f=>f.t);
        for(let i=index;i<data.length && data[i].t<=t;i++){
          const row=data[i];
          if(last?.center && row.center && row.t-last.t<.21)line(last.center,row.center,'#ffc761a8',2.3);
          last=row;
        }
      }
      if($('show-com').checked){dot(center,7,'#1e221b');dot(center,4.5,gold);}
      if($('show-motion').checked){
        for(const [v,c,scale] of [[movement.velocity,'#80caff',.5],[movement.acceleration,'#fd9e7c',.18]]){
          if(!v)continue;
          const end={x:center.x+M.clamp(v.x*scale,-.18,.18),y:center.y+M.clamp(v.y*scale,-.18,.18)};
          const angle=Math.atan2((end.y-center.y)*h,(end.x-center.x)*w);
          line(center,end,c,2.6);
          for(const offset of [-.48,.48]) line(end,{x:end.x-10*Math.cos(angle+offset)/w,y:end.y-10*Math.sin(angle+offset)/h},c,2.6);
        }
      }
    }
    function drawFlat(active,pose) {
      if(flat.hidden)return;
      flat.width=500;flat.height=500;
      const at=(x,y)=>[20+(x+72)*460/144,480-y*460/144];
      const dot=(x,y,r,color)=>{
        flatCtx.fillStyle=color;flatCtx.beginPath();flatCtx.arc(...at(x,y),r,0,Math.PI*2);flatCtx.fill();
      };
      flatCtx.fillStyle='#273230';flatCtx.fillRect(0,0,500,500);
      flatCtx.fillStyle='#726b5b';flatCtx.fillRect(20,20,460,460);
      for(const [id,h] of holds){
        dot(h.x,h.y,2,h.material==='wood'?'#d0be95':'#24292b');
        if($('show-holds').checked) { flatCtx.font='8px monospace';flatCtx.fillStyle='#fff';flatCtx.fillText(id,...at(h.x+.8,h.y+.6)); }
      }
      if(pose && $('show-pose').checked){
        flatCtx.strokeStyle='#e9f3ed';flatCtx.lineWidth=2.5;
        for(const [a,b] of M.links){
          const p=pose.points[a],q=pose.points[b];
          flatCtx.beginPath();flatCtx.moveTo(...at(p.x,p.y));flatCtx.lineTo(...at(q.x,q.y));flatCtx.stroke();
        }
      }
      if(pose && $('show-com').checked){
        const {x,y}=pose.diagnostics.centerOfMass;dot(x,y,4.5,gold);
      }
      for(const c of active){
        const h=holds.get(c.id);
        if(h)dot(h.x,h.y,5,color(c.limb));
      }
    }
    function viewSample(t,active) {
      if(!session?.reconstruction?.length)return {};
      const samples=session.reconstruction,index=V.lowerBound(samples,t,f=>f.t);
      const a=samples[index-1], b=samples[index];
      const nearest=(!a || b && b.t-t<t-a.t) ? b:a;
      const selected=active.map(c=>c.limb+':'+c.id).sort().join(',');
      const poseRow=[a,b].filter(r=>r?.key===selected && Math.abs(r.t-t)<=.13).sort((u,v)=>Math.abs(u.t-t)-Math.abs(v.t-t))[0];
      if(!poseRow)return {forces:nearest?.forces?.balance ? {status:'Between force samples'}:nearest?.forces};
      const blend=a?.pose && b?.pose && b.t-a.t<.21 && a.key===b.key && a.key===selected;
      if(!blend)return poseRow;
      const u=(t-a.t)/(b.t-a.t);
      const from=a.pose,to=b.pose;
      return {forces:poseRow.forces,pose:{...poseRow.pose,
        points:Object.fromEntries(Object.entries(from.points).map(([key,p])=>[key,{x:M.lerp(p.x,to.points[key].x,u),y:M.lerp(p.y,to.points[key].y,u)}])),
        depth:Object.fromEntries(Object.keys(from.depth).map(key=>[key,M.lerp(from.depth[key],to.depth[key],u)])),
        diagnostics:{centerOfMass:Object.fromEntries(['x','y','z'].map(key=>[key,
          M.lerp(from.diagnostics.centerOfMass[key],to.diagnostics.centerOfMass[key],u)]))},
      }};
    }
    function render(timing,meta) {
      if(!metadata || !visible)return;
      const t=Math.max(0,Math.min(metadata.duration,timing));
      $('timebar').value=String(t);
      const frame=M.sample(session?.frames??[],t);
      const sampleIndex=session ? V.lowerBound(session.frames,t,f=>f.t) : 0;
      const movement=M.motionAt(session?.motion??[],frame,t,metadata.width/metadata.height);
      const active=M.contactAt(session?.contacts??[],t===metadata.duration ? t-.0001:t);
      const sample=viewSample(t,active);
      const fit=frame?.image?sample.pose:null;
      const pose=fit?.quality>=.3 && fit.boneError<=4.5 ? fit:null;
      let forces=fit?sample.forces:null;
      if(forces?.balance && frame.kind==='interpolated' && (movement?.speed==null || movement.speed>.15)) {
        forces={status:'No static estimate between these frames'};
      }
      const status=frame?.image ? ' · '+(frame.kind==='observed'?'Tracked sample '+(sampleIndex+1):frame.kind==='interpolated'?'Interpolated pose':'Nearest sample') :
        session ? ' · No tracked pose' : '';
      $('time').textContent=t.toFixed(3)+' / '+metadata.duration.toFixed(3)+' s'+status;
      $('time').title=meta.presented?'Decoded frame timestamp':'Video seek time';
      const stepStatus=$('step-status');
      if(meta.sampled) {stepStatus.textContent='Stepped by sample time';stepStatus.hidden=false;}
      else if(stepStatus.textContent!=='Finding frame…') stepStatus.hidden=true;
      $('fit').textContent=pose?'Estimated from video · '+Math.round(pose.quality*100)+'% fit confidence · '+pose.fitError.toFixed(1)+' in model adjustment':
        fit?'3D fit hidden · Low confidence or inconsistent limb lengths.':
        calibration?'No usable 3D fit at this time.':'Mark board corners to align the estimated body with the wall.';
      $('balance').textContent=forces ? forces.status+(forces.residual?' · '+forces.residual:'')+
        (forces.confidence?' · '+Math.round(forces.confidence*100)+'% estimate confidence':'') : 'No force estimate at this time.';
      const center=movement?.center;
      let phase=movement?.speed==null?'Motion unclear':movement.speed<.035?'Steady':movement.speed<.15?'Weight shift':'Fast motion';
      const matching=active.some((c,i)=>active.slice(0,i).some(other=>other.id===c.id));
      if(matching) phase+=' · Matched hold';
      if(active.length && session?.stances?.length){
        const index=V.lowerBound(session.stances,t,s=>s.end);
        const stance=session.stances[index]?.end===t ? session.stances[index+1]:session.stances[index];
        if(stance) phase+=' · Stance '+(stance.end-stance.start).toFixed(2)+' s';
      }
      $('movement').textContent=center ? phase+' · Projected COM '+(center.x*100).toFixed(1)+'%, '+(center.y*100).toFixed(1)+'%'+
        (movement.speed==null?'':' · '+(movement.speed*100).toFixed(1)+'% image height/s') : 'No tracked center of mass at this time.';
      const angles=movement?.angles;
      $('angles').textContent=frame?.world && angles ? Object.entries(angles).map(([key,value])=>{
        const name=key.replace(/([A-Z])/g,' $1').toLowerCase();
        return name+' '+(value==null?'—':Math.round(value)+'°');
      }).join(' · ') : '';
      const balance=forces?.balance;
      const onHold=$('force-side').value==='hold';
      const routeKey=resultsRevision+':'+active.map(c=>c.limb+c.id).join(',');
      if(routeKey!==activeKey){
        activeKey=routeKey;
        activeRoute={holds:active.map(c=>({id:c.id,role:c.limb.endsWith('Foot')?8:6}))};
      }
      const list=$('live-contacts');
      const listKey=routeKey+':'+onHold;
      if(list.dataset.key!==listKey){
        list.dataset.key=listKey; list.replaceChildren();
        for(const c of active){
          const item=document.createElement('li'), button=seekButton(label[c.limb]+' #'+c.id,c.start);
          button.addEventListener('click',()=>{$('contact-form').closest('details').open=true;editDefaults(c);});
          const text=document.createElement('span');
          text.dataset.limb=c.limb; item.append(button,text); list.append(item);
        }
        if(!active.length){
          const item=document.createElement('li');item.textContent='No active contacts at this time.';list.append(item);
        }
      }
      for(const [i,c] of active.entries()){
        const force=balance?.contacts.find(p=>p.limb===c.limb)?.force;
        const sign=onHold?-1:1;
        list.children[i].lastElementChild.textContent=' '+(c.source==='manual'?'Corrected':Math.round(c.confidence*100)+'% contact')+
          ' · '+(c.end-c.start).toFixed(2)+' s'+
          (force?' · '+Math.hypot(force.x,force.y,force.z).toFixed(2)+' BW · x/y/z '+
          [force.x,force.y,force.z].map(x=>(x*sign).toFixed(2)).join(' / '):'');
      }
      const arrows=$('show-forces').checked;
      const rendered=pose && $('show-pose').checked?pose:null;
      if(!canvas.hidden) view3D?.update(activeRoute,null,rendered,pose && (arrows && balance || $('show-com').checked) ? {
        center:pose.diagnostics.centerOfMass, gravity:arrows ? balance?.gravity : null,
        contacts:arrows ? balance?.contacts??[] : [], analysis:true,onHold,hideCenter:!$('show-com').checked,
      }:null);
      drawFlat(active,pose);
      drawVideo(frame,movement,active,t);
    }
    syncMode();
    return {open,close};
  }
  root.ClimbGenAnalysisUI={init};
})(globalThis);
