/*
 * Offline, classical-CV hold candidate finder for a wall photograph.
 *
 * This is intentionally a candidate generator, not a learned detector. It
 * segments the image by color in Lab space, finds compact connected regions,
 * and scores contrast/shape/size. Busy walls, low contrast, shadows, overlap,
 * and unusual camera angles can cause misses or false positives; keep its
 * output editable and let climbers add/remove/reposition regions.
 */
(function attach(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ClimbGenPhotoDetector = api;
})(typeof globalThis === 'object' ? globalThis : this, () => {
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  const srgb = (v) => {
    v /= 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };

  function writeRgbToLab(r, g, b, target, offset) {
    r = srgb(r); g = srgb(g); b = srgb(b);
    let x = (r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047;
    let y = (r * 0.2126729 + g * 0.7151522 + b * 0.0721750);
    let z = (r * 0.0193339 + g * 0.1191920 + b * 0.9503041) / 1.08883;
    const f = (v) => v > 0.0088564517 ? Math.cbrt(v) : 7.787037 * v + 16 / 116;
    x = f(x); y = f(y); z = f(z);
    target[offset] = 116 * y - 16;
    target[offset + 1] = 500 * (x - y);
    target[offset + 2] = 200 * (y - z);
  }

  function makeCanvas() {
    if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(1, 1);
    if (typeof document !== 'undefined') return document.createElement('canvas');
    throw new Error('Canvas is not available in this environment');
  }

  function readPixels(source, maxSide) {
    const sourceWidth = Number(source?.naturalWidth || source?.videoWidth || source?.width);
    const sourceHeight = Number(source?.naturalHeight || source?.videoHeight || source?.height);
    if (!(sourceWidth > 0 && sourceHeight > 0)) throw new Error('Choose a loaded wall image first');
    const scale = Math.min(1, maxSide / Math.max(sourceWidth, sourceHeight));
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    const canvas = makeCanvas();
    canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Canvas image processing is unavailable');
    context.drawImage(source, 0, 0, width, height);
    return { width, height, pixels: context.getImageData(0, 0, width, height).data };
  }

  function imageLab(pixels, pixelCount) {
    const lab = new Float32Array(pixelCount * 3);
    for (let i = 0; i < pixelCount; i++) {
      const j = i * 4, k = i * 3;
      writeRgbToLab(pixels[j], pixels[j + 1], pixels[j + 2], lab, k);
    }
    return lab;
  }

  function distanceSquared(lab, pixel, center) {
    const k = pixel * 3;
    const dl = lab[k] - center[0], da = lab[k + 1] - center[1], db = lab[k + 2] - center[2];
    return dl * dl + da * da + db * db;
  }

  function fitColorClusters(lab, width, height, requestedClusters) {
    const count = width * height;
    const sampleStep = Math.max(1, Math.floor(Math.sqrt(count / 30000)));
    const samples = [];
    for (let y = 0; y < height; y += sampleStep) {
      for (let x = 0; x < width; x += sampleStep) samples.push(y * width + x);
    }
    const clusters = Math.max(4, Math.min(requestedClusters, 14, samples.length));

    // Deterministic farthest-point seeding avoids a dependency and tends to
    // reserve centers for the wall background plus distinct hold colors.
    const centers = [];
    const first = samples[Math.floor(samples.length / 2)];
    centers.push([lab[first * 3], lab[first * 3 + 1], lab[first * 3 + 2]]);
    const nearest = new Float32Array(samples.length);
    nearest.fill(Infinity);
    for (let c = 1; c < clusters; c++) {
      const previous = centers[c - 1];
      let farthestIndex = 0, farthestDistance = -1;
      for (let i = 0; i < samples.length; i++) {
        const d = distanceSquared(lab, samples[i], previous);
        if (d < nearest[i]) nearest[i] = d;
        if (nearest[i] > farthestDistance) { farthestDistance = nearest[i]; farthestIndex = i; }
      }
      const pixel = samples[farthestIndex];
      centers.push([lab[pixel * 3], lab[pixel * 3 + 1], lab[pixel * 3 + 2]]);
    }

    for (let iteration = 0; iteration < 5; iteration++) {
      const sums = Array.from({ length: clusters }, () => [0, 0, 0, 0]);
      for (let i = 0; i < samples.length; i++) {
        const pixel = samples[i];
        let best = 0, bestDistance = Infinity;
        for (let c = 0; c < clusters; c++) {
          const d = distanceSquared(lab, pixel, centers[c]);
          if (d < bestDistance) { best = c; bestDistance = d; }
        }
        const k = pixel * 3, sum = sums[best];
        sum[0] += lab[k]; sum[1] += lab[k + 1]; sum[2] += lab[k + 2]; sum[3]++;
      }
      for (let c = 0; c < clusters; c++) {
        if (!sums[c][3]) continue;
        centers[c] = [sums[c][0] / sums[c][3], sums[c][1] / sums[c][3], sums[c][2] / sums[c][3]];
      }
    }

    const labels = new Uint8Array(count);
    for (let pixel = 0; pixel < count; pixel++) {
      let best = 0, bestDistance = Infinity;
      for (let c = 0; c < clusters; c++) {
        const d = distanceSquared(lab, pixel, centers[c]);
        if (d < bestDistance) { best = c; bestDistance = d; }
      }
      labels[pixel] = best;
    }
    return { labels, centers };
  }

  function componentCandidates({ width, height, lab, labels, centers }) {
    const count = width * height;
    const minArea = Math.max(10, Math.round(count * 0.000025));
    const maxArea = Math.round(count * 0.045);
    const visited = new Uint8Array(count);
    const stack = new Int32Array(count);
    const candidates = [];

    for (let start = 0; start < count; start++) {
      if (visited[start]) continue;
      visited[start] = 1;
      const cluster = labels[start];
      let top = 0, area = 0, perimeter = 0;
      let minX = width, maxX = -1, minY = height, maxY = -1;
      let sumX = 0, sumY = 0, sumRingL = 0, sumRingA = 0, sumRingB = 0, ringCount = 0;
      stack[top++] = start;

      while (top) {
        const pixel = stack[--top];
        const x = pixel % width, y = (pixel / width) | 0;
        area++; sumX += x; sumY += y;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        // Inline four connected-neighbor checks. This runs once per pixel, so
        // avoid allocating coordinate/neighbor arrays in the hot loop.
        let other, k;
        if (y === 0) perimeter++;
        else {
          other = pixel - width;
          if (labels[other] === cluster) { if (!visited[other]) { visited[other] = 1; stack[top++] = other; } }
          else { perimeter++; k = other * 3; sumRingL += lab[k]; sumRingA += lab[k + 1]; sumRingB += lab[k + 2]; ringCount++; }
        }
        if (y === height - 1) perimeter++;
        else {
          other = pixel + width;
          if (labels[other] === cluster) { if (!visited[other]) { visited[other] = 1; stack[top++] = other; } }
          else { perimeter++; k = other * 3; sumRingL += lab[k]; sumRingA += lab[k + 1]; sumRingB += lab[k + 2]; ringCount++; }
        }
        if (x === 0) perimeter++;
        else {
          other = pixel - 1;
          if (labels[other] === cluster) { if (!visited[other]) { visited[other] = 1; stack[top++] = other; } }
          else { perimeter++; k = other * 3; sumRingL += lab[k]; sumRingA += lab[k + 1]; sumRingB += lab[k + 2]; ringCount++; }
        }
        if (x === width - 1) perimeter++;
        else {
          other = pixel + 1;
          if (labels[other] === cluster) { if (!visited[other]) { visited[other] = 1; stack[top++] = other; } }
          else { perimeter++; k = other * 3; sumRingL += lab[k]; sumRingA += lab[k + 1]; sumRingB += lab[k + 2]; ringCount++; }
        }
      }

      const boxWidth = maxX - minX + 1, boxHeight = maxY - minY + 1;
      const boxArea = boxWidth * boxHeight;
      if (area < minArea || area > maxArea || !boxArea) continue;
      const aspect = boxWidth / boxHeight;
      const fill = area / boxArea;
      if (aspect < 0.18 || aspect > 5.5 || fill < 0.08) continue;
      const touchesEdge = minX === 0 || minY === 0 || maxX === width - 1 || maxY === height - 1;
      const center = centers[cluster];
      let contrast = 0;
      if (ringCount) {
        const dl = center[0] - sumRingL / ringCount;
        const da = center[1] - sumRingA / ringCount;
        const db = center[2] - sumRingB / ringCount;
        contrast = Math.hypot(dl, da, db);
      }
      // Circularity rewards compact regions without rejecting irregular holds.
      const circularity = clamp((4 * Math.PI * area) / Math.max(1, perimeter * perimeter), 0, 1);
      const sizeRatio = area / count;
      const sizeScore = clamp(1 - Math.abs(Math.log(Math.max(sizeRatio, 1e-7)) - Math.log(0.0015)) / 5, 0, 1);
      const contrastScore = clamp(contrast / 38, 0, 1);
      const fillScore = clamp(fill / 0.7, 0, 1);
      const borderPenalty = touchesEdge ? 0.18 : 0;
      const confidence = clamp(0.5 * contrastScore + 0.26 * fillScore + 0.14 * circularity + 0.1 * sizeScore - borderPenalty, 0, 0.98);
      if (confidence < 0.16) continue;
      const padX = Math.max(1, Math.round(boxWidth * 0.08)), padY = Math.max(1, Math.round(boxHeight * 0.08));
      const x0 = clamp(minX - padX, 0, width - 1), x1 = clamp(maxX + padX, 0, width - 1);
      const y0 = clamp(minY - padY, 0, height - 1), y1 = clamp(maxY + padY, 0, height - 1);
      candidates.push({
        x: (sumX / area + 0.5) / width * 100,
        y: (sumY / area + 0.5) / height * 100,
        polygon: [
          { x: x0 / width * 100, y: y0 / height * 100 },
          { x: (x1 + 1) / width * 100, y: y0 / height * 100 },
          { x: (x1 + 1) / width * 100, y: (y1 + 1) / height * 100 },
          { x: x0 / width * 100, y: (y1 + 1) / height * 100 },
        ],
        box: { x: x0 / width * 100, y: y0 / height * 100, width: (x1 - x0 + 1) / width * 100, height: (y1 - y0 + 1) / height * 100 },
        area, confidence, cluster, contrast,
      });
    }
    return candidates;
  }

  function intersectionOverUnion(a, b) {
    const ax0 = a.box.x, ay0 = a.box.y, ax1 = ax0 + a.box.width, ay1 = ay0 + a.box.height;
    const bx0 = b.box.x, by0 = b.box.y, bx1 = bx0 + b.box.width, by1 = by0 + b.box.height;
    const overlap = Math.max(0, Math.min(ax1, bx1) - Math.max(ax0, bx0)) * Math.max(0, Math.min(ay1, by1) - Math.max(ay0, by0));
    return overlap / Math.max(1e-6, a.box.width * a.box.height + b.box.width * b.box.height - overlap);
  }

  function detect(image, options = {}) {
    const maxCandidates = clamp(Math.floor(options.maxCandidates ?? 300), 1, 1000);
    const { width, height, pixels } = readPixels(image, clamp(options.maxSide ?? 480, 256, 480));
    const count = width * height;
    const lab = imageLab(pixels, count);
    const { labels, centers } = fitColorClusters(lab, width, height, options.clusters ?? 12);
    const raw = componentCandidates({ width, height, lab, labels, centers });
    raw.sort((a, b) => b.confidence - a.confidence || b.area - a.area);
    const kept = [];
    for (const candidate of raw) {
      // Different color clusters often split one textured hold. Suppress near
      // duplicates while preserving neighboring holds whose boxes just touch.
      if (kept.some((prior) => intersectionOverUnion(candidate, prior) > 0.72)) continue;
      kept.push({ ...candidate, confidence: Math.round(candidate.confidence * 1000) / 1000 });
      if (kept.length >= maxCandidates) break;
    }
    return { candidates: kept, width, height, method: 'lab-color-components', note: 'Experimental local image segmentation. Confirm or correct every candidate.' };
  }

  return { detect };
});
