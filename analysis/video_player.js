/* Present media timestamps drive every analysis view. */
(function (root) {
  function lowerBound(array, time, key = value => value) {
    let low = 0, high = array.length;
    while (low < high) {
      const middle = (low+high) >>> 1;
      if (key(array[middle]) < time) low = middle+1;
      else high = middle;
    }
    return low;
  }
  function seekDecoded(video, time, signal) {
    return new Promise((resolve, reject) => {
      let callback, timer;
      let mediaTime;
      const cleanup = () => {
        clearTimeout(timer);
        if (callback != null) video.cancelVideoFrameCallback(callback);
        video.removeEventListener('seeked', seeked);
        video.removeEventListener('error', failed);
        signal?.removeEventListener('abort', aborted);
      };
      const finish = () => { cleanup(); resolve({ time: mediaTime ?? video.currentTime, presented: mediaTime != null }); };
      const seeked = () => {
        clearTimeout(timer);
        if (mediaTime != null || !video.requestVideoFrameCallback) finish();
        else timer = setTimeout(finish, 140);
      };
      const failed = () => { cleanup(); reject(new Error('The browser could not decode this video.')); };
      const aborted = () => { cleanup(); reject(new DOMException('Cancelled', 'AbortError')); };
      if (signal?.aborted) { aborted(); return; }
      if (Math.abs(video.currentTime-time)<.0005 && video.readyState>=2 && !video.seeking) {
        finish();
        return;
      }
      signal?.addEventListener('abort', aborted, { once:true });
      video.addEventListener('seeked', seeked, { once:true });
      video.addEventListener('error', failed, { once:true });
      if (video.requestVideoFrameCallback) callback = video.requestVideoFrameCallback((_now, metadata) => {
        callback = null;
        mediaTime = metadata.mediaTime;
        if (!video.seeking && video.readyState>=2) finish();
      });
      timer = setTimeout(failed, 8000);
      video.currentTime = time;
    });
  }
  function attach(video, draw) {
    const knownTimes = [];
    let time = 0, presented = false, stepped = null, seekEpoch = 0;
    function record(t) {
      const index = lowerBound(knownTimes, t);
      if (knownTimes[index] !== t) knownTimes.splice(index,0,t);
    }
    function render(t, exact) {
      time = t;
      presented = exact;
      if (exact) record(t);
      draw(t, { presented:exact, indexed:exact ? lowerBound(knownTimes,t)+1 : null });
    }
    function frame(_now, metadata) {
      if (!video.seeking && !stepped) render(metadata.mediaTime,true);
      video.requestVideoFrameCallback(frame);
    }
    video.requestVideoFrameCallback?.(frame);
    function refresh() {
      if (!stepped && (!presented || Math.abs(video.currentTime-time)>.15)) render(video.currentTime,false);
      else if (!stepped) draw(time,{presented,indexed:presented ? lowerBound(knownTimes,time)+1 : null});
    }
    video.addEventListener('seeked', () => { if (!stepped) render(video.currentTime,false); });
    video.addEventListener('timeupdate', () => { if (!video.requestVideoFrameCallback && !stepped) refresh(); });
    // Discover the boundary of the adjacent decoded frame using the media
    // timestamps. The fallback uses the analyzed timestamps on older browsers.
    async function step(direction, samples) {
      video.pause();
      const epoch = ++seekEpoch;
      const original = time;
      stepped = new AbortController();
      const controller = stepped;
      const end = Math.max(0,video.duration-.001);
      let candidate;
      let near = 0, far = .001;
      try {
        const start = presented ? {time:original,presented:true} :
          await seekDecoded(video, original,controller.signal);
        const origin = start.time;
        if (video.requestVideoFrameCallback && (start.presented || knownTimes.length)) {
          while (far <= 1.024) {
            const decoded = await seekDecoded(video,Math.min(end,Math.max(0,origin+direction*far)),controller.signal);
            if (!decoded.presented) { if (near===0) { far*=2; continue; } break; }
            if ((decoded.time-origin)*direction>.0001) { candidate = decoded; break; }
            near = far;
            far *= 2;
          }
          if (candidate) {
            for (let i=0; i<10 && far-near>.001; i++) {
              const middle = (near+far)/2;
              const decoded = await seekDecoded(video,Math.min(end,Math.max(0,origin+direction*middle)),controller.signal);
              if (!decoded.presented) break;
              if ((decoded.time-origin)*direction>.0001) { candidate=decoded; far=middle; }
              else near=middle;
            }
          }
        }
        const fallback = samples[lowerBound(samples,original + (direction>0 ? .002 : -.002)) - (direction<0 ? 1 : 0)];
        const target = candidate ? candidate.time+.0005 : fallback ?? Math.min(end,Math.max(0,original + direction/12));
        const result = await seekDecoded(video,target,controller.signal);
        if (epoch===seekEpoch) render(candidate?.time ?? result.time,candidate?.presented ?? result.presented);
      } finally { if (stepped === controller) stepped = null; }
    }
    return {
      get time() { return time; },
      refresh,
      reset() { stepped?.abort(); stepped=null; seekEpoch++; knownTimes.length=0; render(0,false); },
      seek(t) { stepped?.abort(); stepped=null; seekEpoch++; video.pause(); video.currentTime=t; render(t,false); },
      async step(direction,samples) { if (!stepped) await step(direction,samples); },
    };
  }
  const api = { attach, lowerBound, seekDecoded };
  root.ClimbGenVideo = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(globalThis);
