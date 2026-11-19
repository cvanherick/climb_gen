/* Classic worker lets the pinned WASM loader use importScripts. */
let model;
self.onmessage = async ({data}) => {
  try {
    if (data.packageRoot) {
      const { FilesetResolver, PoseLandmarker } = await import(data.packageRoot + '/vision_bundle.mjs');
      const files = await FilesetResolver.forVisionTasks(data.packageRoot + '/wasm');
      model = await PoseLandmarker.createFromOptions(files,{
        baseOptions:{ modelAssetPath:data.modelAssetPath, delegate:'CPU' }, runningMode:'VIDEO', numPoses:1,
        minPoseDetectionConfidence:.42, minPosePresenceConfidence:.42, minTrackingConfidence:.45,
      });
      self.postMessage({});
    } else {
      try {
        const {landmarks,worldLandmarks}=model.detectForVideo(data.bitmap,data.t*1000);
        self.postMessage({frame:{t:data.t,image:landmarks[0]??null,world:worldLandmarks[0]??null}});
      } finally { data.bitmap.close(); }
    }
  } catch (error) { self.postMessage({ error:error.message }); }
};
