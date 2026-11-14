/*
 * Rank next-contact suggestions for a manually annotated wall photo.
 * This is a geometric/statistical prior, not the TB2 DDPM: the bundled model
 * is fixed to TB2 hold IDs and cannot infer contacts from arbitrary photos.
 */
(function attach(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ClimbGenPhotoSuggestions = api;
})(typeof globalThis === 'object' ? globalThis : this, () => {
  const DEFAULTS = { width: 120, height: 144, maxReach: 42, minReach: 4, minMoves: 3, finishBand: 0.78 };

  function hash(value) {
    let h = 2166136261;
    for (const char of String(value)) { h ^= char.codePointAt(0); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  function random(seed) {
    let state = seed || 1;
    return () => {
      state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
      return (state >>> 0) / 4294967296;
    };
  }

  function boardPoints(holds, { width, height, normalizedWall = false }) {
    const valid = holds.map((p, index) => ({ index, x: Number(p?.x), y: Number(p?.y) }))
      .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
    if (!valid.length) return [];
    const minX = Math.min(...valid.map((p) => p.x)), maxX = Math.max(...valid.map((p) => p.x));
    const minY = Math.min(...valid.map((p) => p.y)), maxY = Math.max(...valid.map((p) => p.y));
    const spanX = Math.max(1, maxX - minX), spanY = Math.max(1, maxY - minY);
    return valid.map((p) => ({
      ...p,
      // Convert image-origin (top left) coordinates into an upward-positive,
      // board-like coordinate frame. Photo UI coordinates are expected 0–100.
      bx: normalizedWall ? p.x / 100 * width : ((p.x - minX) / spanX) * width,
      by: normalizedWall ? (100 - p.y) / 100 * height : ((maxY - p.y) / spanY) * height,
    }));
  }

  function movementPrior(data, width, height) {
    const placements = new Map((data?.placements || []).map((p) => [String(p.id), p]));
    const dxValues = [], dyValues = [], distanceValues = [];
    for (const route of data?.routes || []) {
      const starts = [], hands = [], finishes = [];
      for (const [id, role] of route.holds || []) {
        const p = placements.get(String(id));
        if (!p) continue;
        const target = role === 5 ? starts : role === 6 ? hands : role === 7 ? finishes : null;
        if (target) target.push(p);
      }
      const pairs = [];
      for (const from of starts) for (const to of hands) pairs.push([from, to]);
      for (const from of hands) for (const to of hands) if (to.y > from.y) pairs.push([from, to]);
      for (const from of hands) for (const to of finishes) pairs.push([from, to]);
      for (const [from, to] of pairs) {
        const x = (to.x - from.x) / 128 * width;
        const y = (to.y - from.y) / 144 * height;
        const d = Math.hypot(x, y);
        if (y < -height * 0.12 || d < 3 || d > 48) continue;
        dxValues.push(Math.abs(x)); dyValues.push(Math.max(0, y)); distanceValues.push(d);
      }
    }
    const mean = (values, fallback) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : fallback;
    return {
      lateral: mean(dxValues, 22),
      rise: mean(dyValues, 18),
      distance: mean(distanceValues, 27),
      samples: distanceValues.length,
    };
  }

  function suggest({ holds = [], sequence = [], data, count = 3, seed, maxReach, minReach, minMoves, finishBand, normalizedWall = false, wallAngleDeg } = {}) {
    const config = { ...DEFAULTS, maxReach, minReach, minMoves, finishBand };
    const points = boardPoints(holds, { ...config, normalizedWall });
    const byIndex = new Map(points.map((p) => [p.index, p]));
    const path = sequence.map(Number).filter((index) => byIndex.has(index));
    if (!path.length) return { suggestions: [], done: false, reason: 'Choose a start hold first.' };
    const used = new Set(path);
    const current = byIndex.get(path.at(-1));
    const previous = path.length > 1 ? byIndex.get(path.at(-2)) : null;
    const prior = movementPrior(data, config.width, config.height);
    const angleIsKnown = wallAngleDeg != null && Number.isFinite(Number(wallAngleDeg));
    const calibratedAngle = angleIsKnown ? Math.max(-20, Math.min(70, Number(wallAngleDeg))) : null;
    // A user-supplied angle only applies a mild heuristic reach adjustment;
    // it is not a measured physical model of strength, friction, or body size.
    const reachScale = calibratedAngle == null ? 1 : 1 - Math.max(0, calibratedAngle) / 70 * 0.16 + Math.max(0, -calibratedAngle) / 20 * 0.04;
    const effectiveMaxReach = config.maxReach * reachScale;
    const isFinishReady = path.length - 1 >= config.minMoves;
    const finishY = config.height * config.finishBand;
    const rng = random(seed == null ? hash(path.join(',') + '|' + holds.length) : hash(seed));
    const gumbel = () => -Math.log(-Math.log(Math.max(1e-6, Math.min(1 - 1e-6, rng()))));
    const candidates = [];

    for (const target of points) {
      if (used.has(target.index)) continue;
      const dx = target.bx - current.bx;
      const dy = target.by - current.by;
      const distance = Math.hypot(dx, dy);
      if (distance < config.minReach || distance > effectiveMaxReach) continue;
      if (dy < -config.height * 0.11) continue;
      const isFinish = isFinishReady && target.by >= finishY && dy >= -config.height * 0.04;
      const rise = Math.max(0, dy);
      const reachScore = 1 - distance / effectiveMaxReach;
      const riseScore = Math.max(-0.5, Math.min(1, rise / Math.max(12, prior.rise * 2.3)));
      const priorDistanceScore = Math.exp(-Math.abs(distance - prior.distance) / Math.max(8, prior.distance));
      const priorRiseScore = rise === 0 ? 0.35 : Math.exp(-Math.abs(rise - prior.rise) / Math.max(8, prior.rise));
      const lateralScore = Math.exp(-Math.abs(Math.abs(dx) - prior.lateral) / Math.max(10, prior.lateral));
      let balanceScore = 0;
      if (previous) {
        const oldDirection = current.bx - previous.bx;
        if (Math.abs(oldDirection) > 7 && Math.sign(dx) === Math.sign(oldDirection)) balanceScore = -0.12;
      }
      const kindBonus = isFinish ? 0.16 : 0;
      const score = reachScore * 0.39 + riseScore * 0.25 + priorDistanceScore * 0.14
        + priorRiseScore * 0.12 + lateralScore * 0.10 + balanceScore + kindBonus + gumbel() * 0.045;
      const rationale = isFinish
        ? 'Upper-wall finish option within reach.'
        : `Reachable ${Math.round(distance)}-unit move with ${Math.round(rise)} units of upward progress${prior.samples ? '; close to TB2 route movement patterns' : ''}${calibratedAngle == null ? '' : `; using a rough ${calibratedAngle}° angle adjustment`}.`;
      candidates.push({ index: target.index, score: Math.round(score * 1000) / 1000, kind: isFinish ? 'finish' : 'move', rationale });
    }
    candidates.sort((a, b) => b.score - a.score || a.index - b.index);
    const limit = Math.max(1, Math.min(8, Number(count) || 3));
    const suggestions = candidates.slice(0, limit);
    return {
      suggestions,
      hasFinishOption: suggestions.some((candidate) => candidate.kind === 'finish'),
      reason: suggestions.length ? undefined : 'No unused holds are within the modeled reach range. Add or select a nearer hold.',
      prior: { source: prior.samples ? 'TB2 community route geometry' : 'geometric fallback', sampleCount: prior.samples, normalizedWall: Boolean(normalizedWall), userSetWallAngleDeg: calibratedAngle, heuristicReachScale: reachScale },
    };
  }

  return { suggest };
});
