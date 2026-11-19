/* Read saved analysis inputs without trusting cached derived conclusions. */
(function (root) {
  const Model = root.ClimbGenAnalysisModel || require('./analysis_model');
  const board = Object.freeze({layout:'TB2 Mirror',sizeInches:[144,144],angleDeg:40});

  function range(start,end,duration) {
    if (![start,end,duration].every(Number.isFinite) || duration<=0 || start<0 || end>duration || end-start<Math.min(.2,duration)) {
      throw new Error('Choose a valid analysis range of at least 0.2 seconds, or use the full video.');
    }
    return {start,end};
  }

  // Hash small samples throughout the source file. This identifies the clip
  // for local review without reading the whole video into memory.
  async function fingerprint(file) {
    if (!root.crypto?.subtle || !file) return null;
    const bytes=65536;
    const offsets=[0,Math.max(0,Math.floor((file.size-bytes)/2)),Math.max(0,file.size-bytes)];
    const parts=await Promise.all(offsets.map(offset=>file.slice(offset,offset+bytes).arrayBuffer()));
    const data=await new Blob([String(file.size)+':',...parts]).arrayBuffer();
    const hash=await root.crypto.subtle.digest('SHA-256',data);
    return Array.from(new Uint8Array(hash),value=>value.toString(16).padStart(2,'0')).join('');
  }

  function restore(saved,video,holds) {
    if (saved?.schemaVersion!==1 || saved.board?.layout!==board.layout ||
      saved.board?.angleDeg!==board.angleDeg || !Array.isArray(saved.board?.sizeInches) ||
      saved.board.sizeInches.length!==2 || saved.board.sizeInches.some(value=>value!==144)) {
      throw new Error('Choose a supported ClimbGen analysis JSON for the 40° TB2 Mirror.');
    }
    const original=saved.video;
    const matchByHash=Boolean(original?.fingerprint && video.fingerprint);
    if (!original || original.width!==video.width || original.height!==video.height ||
      !Number.isFinite(original.duration) || Math.abs(original.duration-video.duration)>.02 ||
      (original.size!=null && video.size!=null && original.size!==video.size) ||
      (matchByHash ? original.fingerprint!==video.fingerprint : original.name!==video.name)) {
      throw new Error('This review belongs to a different video. Open the original clip first.');
    }
    const validNumber=(value,min,max)=>Number.isFinite(value) && value>=min && value<=max;
    if (!validNumber(saved.climber?.heightCm,100,240) ||
      (saved.climber.weightKg!=null && !validNumber(saved.climber.weightKg,20,300))) {
      throw new Error('The saved climber measurements are invalid.');
    }
    if (saved.range && (!Number.isFinite(saved.range.end) || saved.range.end>video.duration+.02)) {
      throw new Error('The saved analysis range is invalid.');
    }
    const bounds=saved.range ? range(saved.range.start,Math.min(saved.range.end,video.duration),video.duration) :
      {start:0,end:video.duration};
    const points=values=>{
      if (values==null) return null;
      return Object.fromEntries(Model.poseKeys.map(key=>{
        const p=values[key];
        if (!p || !['x','y','z'].every(axis=>validNumber(p[axis],-100,100)) ||
          !validNumber(Model.confidence(p),0,1)) throw new Error('The review contains invalid pose landmarks.');
        return [key,{x:p.x,y:p.y,z:p.z,confidence:Model.confidence(p)}];
      }));
    };
    if (!Array.isArray(saved.frames) || !saved.frames.length || saved.frames.length>100000) {
      throw new Error('The review has no supported pose samples.');
    }
    let previous=-Infinity;
    const frames=saved.frames.map(f=>{
      if (!f || !validNumber(f.t,bounds.start,bounds.end) || f.t<=previous) {
        throw new Error('The review contains invalid or unordered pose timestamps.');
      }
      previous=f.t;
      return {t:f.t,image:points(f.image),world:points(f.world)};
    });
    const count=frames.filter(frame=>frame.image).length;
    if (!count) throw new Error('The review contains no tracked poses.');
    if (!Array.isArray(saved.edits)) throw new Error('The saved contact history is invalid.');
    const edits=saved.edits.map(edit=>{
      if (!edit || !Model.limbs.includes(edit.limb) || !validNumber(edit.start,0,video.duration) ||
        !validNumber(edit.end,0,video.duration+.001) || Math.min(video.duration,edit.end)<=edit.start ||
        (edit.id!==null && !holds.has(String(edit.id)))) {
        throw new Error('The review contains an invalid contact correction.');
      }
      return {limb:edit.limb,id:edit.id===null?null:String(edit.id),start:edit.start,end:Math.min(video.duration,edit.end)};
    });
    let corners=null;
    if (saved.calibration!=null) {
      const marks=saved.calibration.corners;
      if (!Array.isArray(marks) || marks.length!==4 || marks.some(p=>!validNumber(p?.x,0,1) || !validNumber(p?.y,0,1))) {
        throw new Error('The saved board corners are invalid.');
      }
      corners=marks.map(({x,y})=>({x,y}));
    }
    return {
      session:{schemaVersion:1,board,video,range:bounds,climber:{heightCm:saved.climber.heightCm,weightKg:saved.climber.weightKg??null},
        sampling:{targetFps:12,tracker:'MediaPipe Pose Landmarker Lite',execution:'saved review'},
        frames,edits,poseCoverage:count/frames.length},
      corners,
      resumeTime:validNumber(saved.reviewTime,0,video.duration)?saved.reviewTime:bounds.start,
    };
  }
  const api={board,range,fingerprint,restore};
  root.ClimbGenAnalysisSession=api;
  if(typeof module==='object' && module.exports) module.exports=api;
})(globalThis);
