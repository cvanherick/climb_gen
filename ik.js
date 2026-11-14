/* Two-dimensional articulated climber model. This is a geometric approximation,
   not a force, friction, collision, or real-world stability simulator. */
(function attach(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ClimbGenIK = api;
})(typeof globalThis === 'object' ? globalThis : this, () => {
  const DEFAULT_BODY = Object.freeze({
    upperArm: 18, lowerArm: 18,
    upperLeg: 19, lowerLeg: 18,
    torsoLength: 15, shoulderWidth: 12, hipWidth: 10,
    headRadius: 3.2,
    elbowMinDeg: 38, elbowMaxDeg: 148,
    kneeMinDeg: 42, kneeMaxDeg: 145,
    torsoAngleLimit: 0.48,
  });

  const LIMBS = Object.freeze({
    leftHand: { kind: 'arm', side: -1 }, rightHand: { kind: 'arm', side: 1 },
    leftFoot: { kind: 'leg', side: -1 }, rightFoot: { kind: 'leg', side: 1 },
  });

  function lookup(placements, id) {
    return placements instanceof Map ? placements.get(String(id)) || placements.get(id) : placements[String(id)];
  }
  function rootFor(limb, torso, body) {
    const spec = LIMBS[limb];
    const offset = spec.kind === 'arm'
      ? [spec.side * body.shoulderWidth / 2, body.torsoLength]
      : [spec.side * body.hipWidth / 2, 0];
    const c = Math.cos(torso.theta), s = Math.sin(torso.theta);
    return { x: torso.x + offset[0] * c - offset[1] * s, y: torso.y + offset[0] * s + offset[1] * c };
  }
  function lengths(limb, body) {
    return LIMBS[limb].kind === 'arm'
      ? [body.upperArm, body.lowerArm]
      : [body.upperLeg, body.lowerLeg];
  }
  function jointAngleDeg(a, b, d) {
    const cosine = Math.max(-1, Math.min(1, (a * a + b * b - d * d) / (2 * a * b)));
    return Math.acos(cosine) * 180 / Math.PI;
  }
  function segmentViolation(a, b, d) {
    return Math.max(0, Math.abs(a - b) + 1.5 - d, d - (a + b - 1.5));
  }
  function twoBone(root, target, upper, lower, bendSide) {
    const dx = target.x - root.x, dy = target.y - root.y;
    const raw = Math.max(1e-5, Math.hypot(dx, dy));
    const d = Math.max(Math.abs(upper - lower) + 0.001, Math.min(upper + lower - 0.001, raw));
    const ux = dx / raw, uy = dy / raw;
    const along = (upper * upper + d * d - lower * lower) / (2 * d);
    const across = Math.sqrt(Math.max(0, upper * upper - along * along));
    return { x: root.x + ux * along - uy * across * bendSide, y: root.y + uy * along + ux * across * bendSide };
  }
  function pointSegmentDistance(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const den = dx * dx + dy * dy;
    const t = den ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / den)) : 0;
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  }
  function convexHull(points) {
    const unique = [...new Map(points.map((p) => [`${p.x.toFixed(3)},${p.y.toFixed(3)}`, p])).values()]
      .sort((a, b) => a.x - b.x || a.y - b.y);
    if (unique.length <= 2) return unique;
    const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    const lower = [];
    for (const p of unique) { while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), p) <= 0) lower.pop(); lower.push(p); }
    const upper = [];
    for (const p of [...unique].reverse()) { while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), p) <= 0) upper.pop(); upper.push(p); }
    lower.pop(); upper.pop(); return lower.concat(upper);
  }
  function outsideHullDistance(point, hull) {
    if (!hull.length) return Infinity;
    if (hull.length === 1) return Math.hypot(point.x - hull[0].x, point.y - hull[0].y);
    if (hull.length === 2) return pointSegmentDistance(point, hull[0], hull[1]);
    let inside = true, minDistance = Infinity;
    for (let i = 0; i < hull.length; i++) {
      const a = hull[i], b = hull[(i + 1) % hull.length];
      if ((b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x) < -1e-6) inside = false;
      minDistance = Math.min(minDistance, pointSegmentDistance(point, a, b));
    }
    return inside ? 0 : minDistance;
  }
  function scoreTorso(torso, contacts, placements, previous, body, overhangDeg) {
    let reachSquared = 0, angleSquared = 0, maxReachViolation = 0, maxAngleViolation = 0;
    const points = {};
    for (const [limb, id] of Object.entries(contacts)) {
      if (id == null) continue;
      const target = lookup(placements, id);
      if (!target) return { cost: Infinity, maxReachViolation: Infinity, maxAngleViolation: Infinity };
      const root = rootFor(limb, torso, body), [a, b] = lengths(limb, body);
      const d = Math.hypot(target.x - root.x, target.y - root.y);
      const reachViolation = segmentViolation(a, b, d);
      const angle = jointAngleDeg(a, b, Math.max(1e-5, d));
      const spec = LIMBS[limb];
      const minAngle = spec.kind === 'arm' ? body.elbowMinDeg : body.kneeMinDeg;
      const maxAngle = spec.kind === 'arm' ? body.elbowMaxDeg : body.kneeMaxDeg;
      const angleViolation = Math.max(0, minAngle - angle, angle - maxAngle);
      maxReachViolation = Math.max(maxReachViolation, reachViolation);
      maxAngleViolation = Math.max(maxAngleViolation, angleViolation);
      reachSquared += reachViolation * reachViolation + 2.2 * Math.max(0, d / (a + b) - 0.78) ** 2;
      angleSquared += angleViolation * angleViolation / 900 + 0.12 * ((angle - 95) / 95) ** 2;
      points[limb] = { root, target: { x: target.x, y: target.y }, angleDeg: angle, reach: d };
    }
    const anchors = Object.values(points).map((p) => p.target);
    const com = { x: torso.x, y: torso.y + body.torsoLength * 0.48 };
    const hull = convexHull(anchors);
    const outside = outsideHullDistance(com, hull);
    // The 40° overhang only scales an out-of-support-polygon penalty by
    // tan(angle). It is not a calculation of force, friction, or fall risk.
    const overhangScale = Math.tan(Math.max(0, Math.min(70, overhangDeg)) * Math.PI / 180);
    const supportCost = (outside / 24) ** 2 * (1 + overhangScale) + Math.max(0, 3 - anchors.length) * 0.18;
    const effort = previous
      ? ((torso.x - previous.x) ** 2 + (torso.y - previous.y) ** 2) / 225 + ((torso.theta - previous.theta) / 0.25) ** 2
      : 0;
    const orientationCost = (torso.theta / body.torsoAngleLimit) ** 2 * 0.2;
    return {
      cost: reachSquared * 12 + angleSquared * 4 + supportCost * 2.4 + effort * 0.12 + orientationCost,
      maxReachViolation, maxAngleViolation, supportCost, com, hull, points,
      reachable: maxReachViolation < 0.1,
      kinematic: maxReachViolation < 0.1 && maxAngleViolation < 0.1,
    };
  }
  function optimizeSeed(seed, contacts, placements, previous, body, overhangDeg, iterations) {
    let torso = { x: seed.x, y: seed.y, theta: seed.theta };
    let best = scoreTorso(torso, contacts, placements, previous, body, overhangDeg);
    let xyStep = 7, angleStep = 0.16;
    for (let i = 0; i < iterations; i++) {
      let improved = false;
      for (const [key, step] of [['x', xyStep], ['y', xyStep], ['theta', angleStep]]) {
        for (const direction of [-1, 1]) {
          const proposal = { ...torso, [key]: torso[key] + direction * step };
          proposal.x = Math.max(-62, Math.min(62, proposal.x));
          proposal.y = Math.max(0, Math.min(144, proposal.y));
          proposal.theta = Math.max(-body.torsoAngleLimit, Math.min(body.torsoAngleLimit, proposal.theta));
          const candidate = scoreTorso(proposal, contacts, placements, previous, body, overhangDeg);
          if (candidate.cost + 1e-9 < best.cost) { torso = proposal; best = candidate; improved = true; }
        }
      }
      if (!improved) { xyStep *= 0.58; angleStep *= 0.58; if (xyStep < 0.14) break; }
    }
    return { torso, score: best };
  }
  function solve(contacts, placements, previous = null, options = {}) {
    const body = { ...DEFAULT_BODY, ...(options.body || {}) };
    const overhangDeg = options.overhangDeg ?? 40;
    const iterations = options.iterations ?? 16;
    const endpoints = Object.values(contacts).filter((id) => id != null).map((id) => lookup(placements, id)).filter(Boolean);
    const mean = endpoints.reduce((acc, p) => ({ x: acc.x + p.x / endpoints.length, y: acc.y + p.y / endpoints.length }), { x: 0, y: 0 });
    const previousTorso = previous || { x: mean.x, y: mean.y - body.torsoLength * 0.7, theta: 0 };
    const seeds = [previousTorso, { x: mean.x, y: mean.y - body.torsoLength * 0.6, theta: 0 }, { x: mean.x, y: mean.y - body.torsoLength, theta: -0.12 }];
    let best = null;
    for (const seed of seeds) {
      const result = optimizeSeed(seed, contacts, placements, previous, body, overhangDeg, iterations);
      if (!best || result.score.cost < best.score.cost) best = result;
    }
    const torso = best.torso;
    const diagnostics = best.score;
    const pose = {
      torso,
      points: {
        pelvis: { x: torso.x, y: torso.y },
        neck: rootFor('leftHand', torso, body),
        head: { x: torso.x, y: torso.y + body.torsoLength + body.headRadius * 2 },
      },
      diagnostics: {
        maxReachViolation: diagnostics.maxReachViolation,
        maxAngleViolationDeg: diagnostics.maxAngleViolation,
        stabilityCost: diagnostics.supportCost,
        estimatedCost: diagnostics.cost,
        reachable: diagnostics.reachable,
        kinematic: diagnostics.kinematic,
        centerOfMass: diagnostics.com,
        supportHull: diagnostics.hull,
      },
    };
    // The shoulder line is represented by both arm roots. The torso line ends at
    // the midpoint between shoulders; lower/upper joints use exact link lengths.
    const leftShoulder = rootFor('leftHand', torso, body), rightShoulder = rootFor('rightHand', torso, body);
    pose.points.leftShoulder = leftShoulder; pose.points.rightShoulder = rightShoulder;
    pose.points.neck = { x: (leftShoulder.x + rightShoulder.x) / 2, y: (leftShoulder.y + rightShoulder.y) / 2 };
    pose.points.leftHip = rootFor('leftFoot', torso, body); pose.points.rightHip = rootFor('rightFoot', torso, body);
    let maxSegmentResidual = 0;
    for (const limb of Object.keys(LIMBS)) {
      const id = contacts[limb];
      if (id == null) { pose.points[limb] = rootFor(limb, torso, body); continue; }
      const endpoint = lookup(placements, id), root = rootFor(limb, torso, body), [a, b] = lengths(limb, body);
      const bendSide = LIMBS[limb].side;
      const joint = twoBone(root, endpoint, a, b, bendSide);
      const upperResidual = Math.abs(Math.hypot(joint.x - root.x, joint.y - root.y) - a);
      const lowerResidual = Math.abs(Math.hypot(endpoint.x - joint.x, endpoint.y - joint.y) - b);
      maxSegmentResidual = Math.max(maxSegmentResidual, upperResidual, lowerResidual);
      if (limb.endsWith('Hand')) {
        pose.points[limb] = { x: endpoint.x, y: endpoint.y };
        pose.points[limb.replace('Hand', 'Elbow')] = joint;
      } else {
        pose.points[limb] = { x: endpoint.x, y: endpoint.y };
        pose.points[limb.replace('Foot', 'Knee')] = joint;
      }
    }
    pose.diagnostics.maxSegmentResidual = maxSegmentResidual;
    pose.diagnostics.kinematic = pose.diagnostics.kinematic && maxSegmentResidual < 0.1;
    return pose;
  }
  function interpolate(a, b, t) {
    const out = {};
    for (const key of Object.keys(a)) {
      if (a[key] && typeof a[key].x === 'number' && b[key] && typeof b[key].x === 'number') {
        out[key] = { x: a[key].x + (b[key].x - a[key].x) * t, y: a[key].y + (b[key].y - a[key].y) * t };
      }
    }
    return out;
  }
  return { DEFAULT_BODY, LIMBS, solve, interpolate, lookup, segmentViolation, convexHull, outsideHullDistance };
});
