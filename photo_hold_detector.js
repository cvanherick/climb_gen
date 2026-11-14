/*
 * Offline, classical-CV hold candidate finder for a wall photograph.
 *
 * This is intentionally a candidate generator, not a learned detector. It
 * segments the image into a photo-local color palette, cleans pixel speckles,
 * finds compact regions, and scores each against its immediate border and
 * shape. It is still a classical CV proposal engine, not a trained detector.
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

  function smoothLabels(labels, width, height, clusters) {
    // A small majority filter removes isolated sensor/texture pixels before
    // component extraction. Keep ambiguous edges unchanged so nearby holds
    // retain their boundary instead of being aggressively fused.
    const result = labels.slice();
    const counts = new Uint8Array(clusters);
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const pixel = y * width + x;
        counts.fill(0);
        for (let dy = -1; dy <= 1; dy++) {
          const row = pixel + dy * width;
          for (let dx = -1; dx <= 1; dx++) counts[labels[row + dx]]++;
        }
        let winner = labels[pixel], amount = counts[winner];
        for (let cluster = 0; cluster < clusters; cluster++) {
          if (counts[cluster] > amount) { winner = cluster; amount = counts[cluster]; }
        }
        if (amount >= 6) result[pixel] = winner;
      }
    }
    return result;
  }

  function labelsFromLocalContrast(lab, width, height, threshold = 16) {
    const stride = width + 1;
    const size = stride * (height + 1);
    const sumL = new Float32Array(size), sumA = new Float32Array(size), sumB = new Float32Array(size);
    for (let y = 1; y <= height; y++) {
      let rowL = 0, rowA = 0, rowB = 0;
      for (let x = 1; x <= width; x++) {
        const pixelOffset = ((y - 1) * width + (x - 1)) * 3;
        const index = y * stride + x;
        rowL += lab[pixelOffset]; rowA += lab[pixelOffset + 1]; rowB += lab[pixelOffset + 2];
        const above = index - stride;
        sumL[index] = sumL[above] + rowL;
        sumA[index] = sumA[above] + rowA;
        sumB[index] = sumB[above] + rowB;
      }
    }
    const labels = new Uint8Array(width * height);
    let foregroundL = 0, foregroundA = 0, foregroundB = 0, foregroundCount = 0;
    let backgroundL = 0, backgroundA = 0, backgroundB = 0, backgroundCount = 0;
    const radius = 9;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const x0 = Math.max(0, x - radius), x1 = Math.min(width, x + radius + 1);
        const y0 = Math.max(0, y - radius), y1 = Math.min(height, y + radius + 1);
        const a = y0 * stride + x0, b = y0 * stride + x1, c = y1 * stride + x0, d = y1 * stride + x1;
        const area = Math.max(1, (x1 - x0) * (y1 - y0));
        const localL = (sumL[d] - sumL[b] - sumL[c] + sumL[a]) / area;
        const localA = (sumA[d] - sumA[b] - sumA[c] + sumA[a]) / area;
        const localB = (sumB[d] - sumB[b] - sumB[c] + sumB[a]) / area;
        const pixel = y * width + x, offset = pixel * 3;
        const delta = Math.hypot(lab[offset] - localL, lab[offset + 1] - localA, lab[offset + 2] - localB);
        if (delta >= threshold) {
          labels[pixel] = 1;
          foregroundL += lab[offset]; foregroundA += lab[offset + 1]; foregroundB += lab[offset + 2]; foregroundCount++;
        } else {
          backgroundL += lab[offset]; backgroundA += lab[offset + 1]; backgroundB += lab[offset + 2]; backgroundCount++;
        }
      }
    }
    // Remove isolated texture specks and fill one-pixel gaps in a hold mask.
    const cleaned = labels.slice();
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const pixel = y * width + x;
        let neighbors = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const row = pixel + dy * width;
          for (let dx = -1; dx <= 1; dx++) neighbors += labels[row + dx];
        }
        if (labels[pixel] && neighbors <= 2) cleaned[pixel] = 0;
        else if (!labels[pixel] && neighbors >= 7) cleaned[pixel] = 1;
      }
    }
    const centers = [
      [backgroundL / Math.max(backgroundCount, 1), backgroundA / Math.max(backgroundCount, 1), backgroundB / Math.max(backgroundCount, 1)],
      [foregroundL / Math.max(foregroundCount, 1), foregroundA / Math.max(foregroundCount, 1), foregroundB / Math.max(foregroundCount, 1)],
    ];
    return { labels: cleaned, centers };
  }

  function pointInPolygon(x, y, polygon) {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const a = polygon[i], b = polygon[j];
      const crosses = (a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x;
      if (crosses) inside = !inside;
    }
    return inside;
  }

  function makeWallMask(width, height, polygon) {
    if (!Array.isArray(polygon) || polygon.length !== 4 || !polygon.every((point) => Number.isFinite(point?.x) && Number.isFinite(point?.y))) return null;
    const mask = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (pointInPolygon((x + 0.5) / width * 100, (y + 0.5) / height * 100, polygon)) mask[y * width + x] = 1;
      }
    }
    return mask;
  }

  function componentCandidates({ width, height, lab, labels, centers, wallMask }) {
    const count = width * height;
    const minArea = Math.max(18, Math.round(count * 0.00004));
    const maxArea = Math.round(count * 0.035);
    const visited = new Uint8Array(count);
    const stack = new Int32Array(count);
    const candidates = [];

    for (let start = 0; start < count; start++) {
      if (visited[start]) continue;
      if (wallMask && !wallMask[start]) { visited[start] = 1; continue; }
      visited[start] = 1;
      const cluster = labels[start];
      let top = 0, area = 0, perimeter = 0;
      let minX = width, maxX = -1, minY = height, maxY = -1, touchesWallEdge = false;
      let sumX = 0, sumY = 0, sumRingL = 0, sumRingA = 0, sumRingB = 0, ringCount = 0, sumColorVariance = 0;
      stack[top++] = start;

      while (top) {
        const pixel = stack[--top];
        const x = pixel % width, y = (pixel / width) | 0;
        area++; sumX += x; sumY += y;
        sumColorVariance += distanceSquared(lab, pixel, centers[cluster]);
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        // Inline four connected-neighbor checks. This runs once per pixel, so
        // avoid allocating coordinate/neighbor arrays in the hot loop.
        let other, k;
        if (y === 0) perimeter++;
        else {
          other = pixel - width;
          if (wallMask && !wallMask[other]) { perimeter++; touchesWallEdge = true; }
          else if (labels[other] === cluster) { if (!visited[other]) { visited[other] = 1; stack[top++] = other; } }
          else { perimeter++; k = other * 3; sumRingL += lab[k]; sumRingA += lab[k + 1]; sumRingB += lab[k + 2]; ringCount++; }
        }
        if (y === height - 1) perimeter++;
        else {
          other = pixel + width;
          if (wallMask && !wallMask[other]) { perimeter++; touchesWallEdge = true; }
          else if (labels[other] === cluster) { if (!visited[other]) { visited[other] = 1; stack[top++] = other; } }
          else { perimeter++; k = other * 3; sumRingL += lab[k]; sumRingA += lab[k + 1]; sumRingB += lab[k + 2]; ringCount++; }
        }
        if (x === 0) perimeter++;
        else {
          other = pixel - 1;
          if (wallMask && !wallMask[other]) { perimeter++; touchesWallEdge = true; }
          else if (labels[other] === cluster) { if (!visited[other]) { visited[other] = 1; stack[top++] = other; } }
          else { perimeter++; k = other * 3; sumRingL += lab[k]; sumRingA += lab[k + 1]; sumRingB += lab[k + 2]; ringCount++; }
        }
        if (x === width - 1) perimeter++;
        else {
          other = pixel + 1;
          if (wallMask && !wallMask[other]) { perimeter++; touchesWallEdge = true; }
          else if (labels[other] === cluster) { if (!visited[other]) { visited[other] = 1; stack[top++] = other; } }
          else { perimeter++; k = other * 3; sumRingL += lab[k]; sumRingA += lab[k + 1]; sumRingB += lab[k + 2]; ringCount++; }
        }
      }

      const boxWidth = maxX - minX + 1, boxHeight = maxY - minY + 1;
      const boxArea = boxWidth * boxHeight;
      if (area < minArea || area > maxArea || !boxArea) continue;
      const aspect = boxWidth / boxHeight;
      const fill = area / boxArea;
      if (aspect < 0.22 || aspect > 4.2 || fill < 0.11) continue;
      const touchesEdge = touchesWallEdge || minX === 0 || minY === 0 || maxX === width - 1 || maxY === height - 1;
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
      const sizeScore = clamp(1 - Math.abs(Math.log(Math.max(sizeRatio, 1e-7)) - Math.log(0.0012)) / 4.5, 0, 1);
      const contrastScore = clamp(contrast / 38, 0, 1);
      const fillScore = clamp(fill / 0.7, 0, 1);
      const colorConsistency = clamp(1 - Math.sqrt(sumColorVariance / area) / 36, 0, 1);
      const borderPenalty = touchesEdge ? 0.22 : 0;
      const confidence = clamp(0.4 * contrastScore + 0.2 * fillScore + 0.13 * circularity + 0.12 * sizeScore + 0.15 * colorConsistency - borderPenalty, 0, 0.98);
      if (confidence < 0.3) continue;
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

  function isDuplicate(candidate, prior) {
    const overlap = intersectionOverUnion(candidate, prior);
    if (overlap < 0.3) return false;
    const dx = candidate.x - prior.x, dy = candidate.y - prior.y;
    const distance = Math.hypot(dx, dy);
    const diagonal = Math.hypot(
      Math.min(candidate.box.width, prior.box.width),
      Math.min(candidate.box.height, prior.box.height),
    );
    // Suppress repeated color-cluster outlines for the same hold while keeping
    // neighboring holds when their centers remain distinct.
    return distance < diagonal * 0.34 || overlap > 0.78;
  }

  function detect(image, options = {}) {
    const maxCandidates = clamp(Math.floor(options.maxCandidates ?? 300), 1, 1000);
    const minConfidence = clamp(Number(options.minConfidence ?? 0.42), 0, 0.98);
    const { width, height, pixels } = readPixels(image, clamp(options.maxSide ?? 720, 384, 960));
    const count = width * height;
    const lab = imageLab(pixels, count);
    const wallMask = makeWallMask(width, height, options.wallPolygon);
    const clustered = fitColorClusters(lab, width, height, options.clusters ?? 12);
    const colorLabels = smoothLabels(clustered.labels, width, height, clustered.centers.length);
    const colorCandidates = componentCandidates({ width, height, lab, labels: colorLabels, centers: clustered.centers, wallMask });
    const contrast = labelsFromLocalContrast(lab, width, height, options.localContrastThreshold ?? 16);
    const contrastCandidates = componentCandidates({ width, height, lab, labels: contrast.labels, centers: contrast.centers, wallMask });
    const raw = [...colorCandidates, ...contrastCandidates].filter((candidate) => candidate.confidence >= minConfidence);
    raw.sort((a, b) => b.confidence - a.confidence || b.contrast - a.contrast);
    const kept = [];
    for (const candidate of raw) {
      if (kept.some((prior) => isDuplicate(candidate, prior))) continue;
      kept.push({ ...candidate, confidence: Math.round(candidate.confidence * 1000) / 1000 });
      if (kept.length >= maxCandidates) break;
    }
    return { candidates: kept, width, height, method: 'local contrast + color regions', note: 'Auto marks are proposals. Review close, shadowed, and same-colored holds.' };
  }

  return { detect };
});
