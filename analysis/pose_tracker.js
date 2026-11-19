/* Lazy MediaPipe initialization. A worker receives only decoded bitmaps. */
(function (root) {
  const packageRoot = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21';
  const modelAssetPath = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';
  const scriptURL = document.currentScript?.src;
  async function landmarker() {
    const { FilesetResolver, PoseLandmarker } = await import(packageRoot + '/vision_bundle.mjs');
    const files = await FilesetResolver.forVisionTasks(packageRoot + '/wasm');
    return PoseLandmarker.createFromOptions(files,{
      baseOptions:{ modelAssetPath, delegate:'CPU' }, runningMode:'VIDEO', numPoses:1,
      minPoseDetectionConfidence:.42, minPosePresenceConfidence:.42, minTrackingConfidence:.45,
    });
  }
  function read(model, image, t) {
    const { landmarks, worldLandmarks } = model.detectForVideo(image,t*1000);
    return { t, image: landmarks[0] ?? null, world: worldLandmarks[0] ?? null };
  }
  function workerClient(signal) {
    if (!scriptURL || !window.Worker || !window.createImageBitmap || !window.OffscreenCanvas) return null;
    let worker;
    try {
      const url = new URL('./pose_worker.js',scriptURL);
      url.search = new URL(scriptURL).search;
      worker = new Worker(url);
    } catch { return null; }
    const call = (message, transfer = [], timeout = 30000) => new Promise((resolve,reject) => {
      const clean = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort',abort);
        worker.onmessage = worker.onerror = null;
      };
      const fail = error => { clean(); reject(error); };
      const abort = () => fail(new DOMException('Cancelled','AbortError'));
      const timer = setTimeout(() => fail(new Error('The pose worker timed out.')),timeout);
      signal.addEventListener('abort',abort,{ once:true });
      if (signal.aborted) { abort(); return; }
      worker.onerror = () => fail(new Error('The pose worker could not start.'));
      worker.onmessage = ({data}) => {
        clean();
        if (data.error) reject(new Error(data.error));
        else resolve(data.frame);
      };
      try { worker.postMessage(message,transfer); } catch (error) { fail(error); }
    });
    return { start:() => call({ packageRoot, modelAssetPath }), read:(bitmap,t) => call({ bitmap,t },[bitmap]), close:() => worker.terminate() };
  }
  async function analyze(video, signal, update) {
    const frames = [];
    const worker = workerClient(signal);
    let currentWorker = worker, model;
    const canvas = document.createElement('canvas');
    const scale = Math.min(1,960/Math.max(video.videoWidth,video.videoHeight));
    canvas.width = Math.round(video.videoWidth*scale);
    canvas.height = Math.round(video.videoHeight*scale);
    const ctx = canvas.getContext('2d');
    const step = 1/12;
    const expected = Math.max(1,Math.ceil(video.duration/step));
    try {
      if (currentWorker) {
        try { await currentWorker.start(); }
        catch { currentWorker.close(); currentWorker=null; }
      }
      for (let i=0; i<expected; i++) {
        signal.throwIfAborted();
        const decoded = await root.ClimbGenVideo.seekDecoded(video, Math.min(i*step,video.duration-.001),signal);
        const t = Math.max(0,decoded.time);
        if (frames.length && t <= frames.at(-1).t+.0001) continue;
        ctx.drawImage(video,0,0,canvas.width,canvas.height);
        let frame;
        if (currentWorker) {
          let bitmap;
          try {
            bitmap=await createImageBitmap(canvas);
            frame=await currentWorker.read(bitmap,t);
          } catch {
            bitmap?.close();
            currentWorker.close();
            currentWorker=null;
          }
        }
        signal.throwIfAborted();
        if (!currentWorker) {
          model ??= await landmarker();
          signal.throwIfAborted();
          frame=read(model,canvas,t);
        }
        frames.push(frame);
        update(frames.length,(i+1)/expected,currentWorker ? 'worker' : 'main thread');
        await new Promise(resolve => setTimeout(resolve,0));
      }
      return frames;
    } finally {
      currentWorker?.close();
      model?.close();
    }
  }
  root.ClimbGenPoseTracker = { analyze };
})(globalThis);
