/* Two-dimensional articulated climber model. This is a geometric approximation,
   not a force, friction, collision, or real-world stability simulator. */
(function attach(root, factory) {
  const spectrum = root.ClimbGenHoldSpectrum || (typeof require === 'function' ? require('./hold_spectrum') : null);
  const api = factory(spectrum);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ClimbGenIK = api;
})(typeof globalThis === 'object' ? globalThis : this, (spectrum) => {
  const DEFAULT_BODY = Object.freeze({
    upperArm: 16.5, lowerArm: 16,
    upperLeg: 19, lowerLeg: 18,
    torsoLength: 19, shoulderWidth: 13, hipWidth: 10,
    headRadius: 3.2,
    elbowMinDeg: 38, elbowMaxDeg: 148,
    kneeMinDeg: 42, kneeMaxDeg: 145,
    torsoAngleLimit: 0.48, hipAngleLimit: 0.40,
    palmLength: 1.5, fingerLength: 1.1, footLength: 3.4,

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
    const rotation = spec.kind === 'leg' ? (torso.hipTheta || 0) : torso.theta;
    const c = Math.cos(rotation), s = Math.sin(rotation);
    return { x: torso.x + offset[0] * c - offset[1] * s, y: torso.y + offset[0] * s + offset[1] * c };
  }
  function lengths(limb, body) {
    return LIMBS[limb].kind === 'arm'
      ? [body.upperArm, body.lowerArm + body.palmLength]
      : [body.upperLeg, body.lowerLeg];
  }
  function limbTarget(limb, contact, torso, body) {
    if (LIMBS[limb].kind === 'arm') return contact;
    const sign = LIMBS[limb].side;
    return { x: contact.x - sign * Math.cos(torso.hipTheta || 0) * body.footLength * 0.6, y: contact.y + 1.5 };
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
  function directionPenalty(target, root) {
    const profile = target.profile;
    if (!profile || profile.unknown) return { cost: 0, weight: 0, mismatch: 0 };
    const length = Math.hypot(root.x - target.x, root.y - target.y);
    const norm = Math.hypot(profile.pull?.x || 0, profile.pull?.y || 0);
    if (length < 1e-5 || norm < 1e-5) return { cost: 0, weight: 0, mismatch: 0 };
    const alignment = Math.max(-1, Math.min(1, ((root.x - target.x) * profile.pull.x + (root.y - target.y) * profile.pull.y) / (length * norm)));
    const weight = profile.verified ? 1 : 0.08;
    // A hold can be useful from a broad cone of body positions; image shape
    // does not identify a unique contact normal. Reviewed labels narrow this
    // preference slightly, while remaining soft costs rather than constraints.
    const angle = Math.acos(alignment);
    const freeAngle = (profile.verified ? 55 : 80) * Math.PI / 180;
    const mismatch = Math.max(0, angle - freeAngle) / (Math.PI - freeAngle);
    return { cost: weight * mismatch * mismatch, weight, mismatch };
  }
  // A torso search can examine hundreds of poses on exactly the same holds.
  // Resolve those contacts and their support polygon once per stance.
  function contactGeometry(contacts, placements, airborneLimb = null) {
    const targets = [], anchors = [];
    for (const [limb, id] of Object.entries(contacts)) {
      if (id == null) continue;
      const target = lookup(placements, id);
      targets.push({ limb, target });
      if (target && limb !== airborneLimb) anchors.push({ x: target.x, y: target.y });
    }
    return { targets, hull: convexHull(anchors), count: anchors.length };
  }
  function scoreTorso(torso, geometry, previous, body, overhangDeg) {
    let reachSquared = 0, angleSquared = 0, maxReachViolation = 0, maxAngleViolation = 0;
    let directionCost = 0, directionContacts = 0, reviewedContacts = 0, footDifficultyCost = 0, handDifficultyCost = 0;
    for (const { limb, target } of geometry.targets) {
      if (!target) return { cost: Infinity, maxReachViolation: Infinity, maxAngleViolation: Infinity };
      const root = rootFor(limb, torso, body), [a, b] = lengths(limb, body);
      const boneTarget = limbTarget(limb, target, torso, body);
      const d = Math.hypot(boneTarget.x - root.x, boneTarget.y - root.y);
      // Hand pull direction is from hold toward the shoulder. Foot force signs
      // cannot be inferred from these hand-grip screenshot annotations.
      if (LIMBS[limb].kind === 'arm') {
        const direction = directionPenalty(target, root);
        directionCost += direction.cost;
        if (direction.weight) directionContacts++;
        if (direction.weight === 1) reviewedContacts++;
      }
      const reachViolation = segmentViolation(a, b, d);
      if (LIMBS[limb].kind === 'leg') footDifficultyCost += spectrum?.footDifficulty(target, root).cost || 0;
      const difficulty = target.difficulty;
      if (LIMBS[limb].kind === 'arm' && Number.isInteger(difficulty?.handTier)) {
        handDifficultyCost += difficulty.handConfidence * (difficulty.handTier / 3) * (0.4 + 0.6 * Math.min(1, d / (a + b)));
      }
      const angle = jointAngleDeg(a, b, Math.max(1e-5, d));
      const spec = LIMBS[limb];
      const minAngle = spec.kind === 'arm' ? body.elbowMinDeg : body.kneeMinDeg;
      const maxAngle = spec.kind === 'arm' ? body.elbowMaxDeg : body.kneeMaxDeg;
      const angleViolation = Math.max(0, minAngle - angle, angle - maxAngle);
      maxReachViolation = Math.max(maxReachViolation, reachViolation);
      maxAngleViolation = Math.max(maxAngleViolation, angleViolation);
      reachSquared += reachViolation * reachViolation + 2.2 * Math.max(0, d / (a + b) - 0.78) ** 2;
      angleSquared += angleViolation * angleViolation / 900 + 0.12 * ((angle - 95) / 95) ** 2;
    }
    const com = { x: torso.x, y: torso.y + body.torsoLength * 0.48 };
    const hull = geometry.hull;
    const outside = outsideHullDistance(com, hull);
    // The 40° overhang only scales an out-of-support-polygon penalty by
    // tan(angle). It is not a calculation of force, friction, or fall risk.
    const overhangScale = Math.tan(Math.max(0, Math.min(70, overhangDeg)) * Math.PI / 180);
    const supportCost = (outside / 24) ** 2 * (1 + overhangScale) + Math.max(0, 3 - geometry.count) * 0.18;
    const effort = previous
      ? ((torso.x - previous.x) ** 2 + (torso.y - previous.y) ** 2) / 225 + ((torso.theta - previous.theta) / 0.25) ** 2 + (((torso.hipTheta || 0) - (previous.hipTheta || 0)) / 0.25) ** 2
      : 0;
    const orientationCost = (torso.theta / body.torsoAngleLimit) ** 2 * 0.2
      + ((torso.hipTheta || 0) / body.hipAngleLimit) ** 2 * 0.1
      + ((torso.theta - (torso.hipTheta || 0)) / 0.7) ** 2 * 0.12;
    return {
      cost: reachSquared * 12 + angleSquared * 4 + supportCost * 2.4 + effort * 0.12 + orientationCost + directionCost * 3 + footDifficultyCost * 0.35 + handDifficultyCost * 0.25,
      maxReachViolation, maxAngleViolation, supportCost, directionCost, footDifficultyCost, handDifficultyCost, directionContacts, reviewedContacts, com, hull,
      reachable: maxReachViolation < 0.1,
      kinematic: maxReachViolation < 0.1 && maxAngleViolation < 0.1,
    };
  }
  function optimizeSeed(seed, geometry, previous, body, overhangDeg, iterations) {
    let torso = { x: seed.x, y: seed.y, theta: seed.theta, hipTheta: seed.hipTheta || 0 };
    let best = scoreTorso(torso, geometry, previous, body, overhangDeg);
    let xyStep = 7, angleStep = 0.16;
    for (let i = 0; i < iterations; i++) {
      let improved = false;
      for (const [key, step] of [['x', xyStep], ['y', xyStep], ['theta', angleStep], ['hipTheta', angleStep]]) {
        for (const direction of [-1, 1]) {
          const proposal = { ...torso, [key]: torso[key] + direction * step };
          proposal.x = Math.max(-62, Math.min(62, proposal.x));
          proposal.y = Math.max(0, Math.min(144, proposal.y));
          proposal.theta = Math.max(-body.torsoAngleLimit, Math.min(body.torsoAngleLimit, proposal.theta));
          proposal.hipTheta = Math.max(-body.hipAngleLimit, Math.min(body.hipAngleLimit, proposal.hipTheta));
          const candidate = scoreTorso(proposal, geometry, previous, body, overhangDeg);
          if (candidate.cost + 1e-9 < best.cost) { torso = proposal; best = candidate; improved = true; }
        }
      }
      if (!improved) { xyStep *= 0.58; angleStep *= 0.58; if (xyStep < 0.14) break; }
    }
    return { torso, score: best };
  }
  function extremities(pose, body, motion) {
    const unit = (a, b) => {
      const d = Math.max(1e-6, Math.hypot(b.x - a.x, b.y - a.y));
      return { x: (b.x - a.x) / d, y: (b.y - a.y) / d };
    };
    pose.hands = {}; pose.feet = {};
    for (const side of ['left', 'right']) {
      const sign = side === 'left' ? -1 : 1;
      const contact = pose.points[side + 'Hand'], elbow = pose.points[side + 'Elbow'];
      const toe = pose.points[side + 'Foot'], knee = pose.points[side + 'Knee'];
      if (contact && elbow) {
        const grip = motion?.movingLimb === side + 'Hand' ? motion.grip : 1;
        const axis = unit(elbow, contact), lateral = { x: -axis.y, y: axis.x };
        const wrist = { x: contact.x - axis.x * body.palmLength, y: contact.y - axis.y * body.palmLength };
        pose.points[side + 'Wrist'] = wrist;
        const fingers = [];
        // Five three-segment digit chains curl toward the contact. Their
        // lengths and curl are illustrative; the contact anchor stays fixed.
        for (let digit = 0; digit < 5; digit++) {
          const spread = (digit - 2) * (0.28 + (1 - grip) * 0.12);
          const base = { x: contact.x - axis.x * 0.45 + lateral.x * spread, y: contact.y - axis.y * 0.45 + lateral.y * spread };
          const chain = [base];
          let angle = Math.atan2(axis.y, axis.x) + (digit === 0 ? sign * 0.7 : 0);
          const length = body.fingerLength * (digit === 0 ? 0.7 : digit === 2 ? 1 : 0.86);
          for (let joint = 0; joint < 3; joint++) {
            angle += sign * (joint ? 0.12 + 0.53 * grip : 0.15);
            const last = chain.at(-1), segment = length * [0.44, 0.33, 0.23][joint];
            chain.push({ x: last.x + Math.cos(angle) * segment, y: last.y + Math.sin(angle) * segment });
          }
          fingers.push(chain);
        }
        pose.hands[side] = { wrist, contact, fingers };
      }
      if (toe && knee) {
        const angle = (pose.torso.hipTheta || 0) + sign * 0.22;
        const heel = { x: toe.x - sign * Math.cos(angle) * body.footLength, y: toe.y - 0.2 };
        const ankle = limbTarget(side + 'Foot', toe, pose.torso, body);
        pose.points[side + 'Ankle'] = ankle; pose.points[side + 'Heel'] = heel; pose.points[side + 'Toe'] = { ...toe };
        pose.feet[side] = { ankle, heel, toe, knee };
      }
    }
  }
  function solve(contacts, placements, previous = null, options = {}) {
    const body = { ...DEFAULT_BODY, ...(options.body || {}) };
    const overhangDeg = options.overhangDeg ?? 40;
    const iterations = options.iterations ?? 16;
    const geometry = contactGeometry(contacts, placements);
    const endpoints = geometry.targets.map(({ target }) => target).filter(Boolean);
    const mean = endpoints.reduce((acc, p) => ({ x: acc.x + p.x / endpoints.length, y: acc.y + p.y / endpoints.length }), { x: 0, y: 0 });
    const previousTorso = previous || { x: mean.x, y: mean.y - body.torsoLength * 0.7, theta: 0 };
    const seeds = [previousTorso, { x: mean.x, y: mean.y - body.torsoLength * 0.6, theta: 0 }, { x: mean.x, y: mean.y - body.torsoLength, theta: -0.12 }];
    let best = null;
    for (const seed of seeds) {
      const result = optimizeSeed(seed, geometry, previous, body, overhangDeg, iterations);
      if (!best || result.score.cost < best.score.cost) best = result;
    }
    return poseAt(best.torso, contacts, placements, options);
  }
  // Rendering a continuous trajectory must not restart the torso optimizer.
  function poseAt(torso, contacts, placements, options = {}) {
    const body = { ...DEFAULT_BODY, ...(options.body || {}) };
    const motion = options.motion;
    const geometry = contactGeometry(contacts, placements, motion?.airborne ? motion.movingLimb : null);
    const diagnostics = scoreTorso(torso, geometry, null, body, options.overhangDeg ?? 40);
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
        holdDirectionCost: diagnostics.directionCost,
        footDifficultyCost: diagnostics.footDifficultyCost,
        handDifficultyCost: diagnostics.handDifficultyCost,
        directionContacts: diagnostics.directionContacts,
        reviewedDirectionContacts: diagnostics.reviewedContacts,
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
    const gaze = motion?.gazeTarget;
    const headTilt = gaze ? Math.max(-0.32, Math.min(0.32,
      Math.atan2(gaze.x - pose.points.neck.x, Math.max(12, gaze.y - pose.points.neck.y)))) * motion.attention : 0;
    pose.points.head = {
      x: pose.points.neck.x - Math.sin(torso.theta - headTilt) * body.headRadius * 1.65,
      y: pose.points.neck.y + Math.cos(torso.theta - headTilt) * body.headRadius * 1.65,
    };
    pose.points.leftHip = rootFor('leftFoot', torso, body); pose.points.rightHip = rootFor('rightFoot', torso, body);
    let maxSegmentResidual = 0;
    for (const limb of Object.keys(LIMBS)) {
      const id = contacts[limb];
      if (id == null) { pose.points[limb] = rootFor(limb, torso, body); continue; }
      const endpoint = lookup(placements, id), root = rootFor(limb, torso, body), [a, b] = lengths(limb, body);
      const boneEndpoint = limbTarget(limb, endpoint, torso, body);
      const bendSide = LIMBS[limb].kind === 'arm' ? -LIMBS[limb].side : LIMBS[limb].side;
      const jointKey = limb.replace('Hand', 'Elbow').replace('Foot', 'Knee');
      const previousJoint = options.previousPose?.points?.[jointKey];
      const candidates = [twoBone(root, boneEndpoint, a, b, bendSide), twoBone(root, boneEndpoint, a, b, -bendSide)];
      const jointScore = (joint, index) => {
        const continuity = previousJoint ? Math.hypot(joint.x - previousJoint.x, joint.y - previousJoint.y) / (a + b) : 0;
        const direction = LIMBS[limb].kind === 'arm' ? directionPenalty(endpoint, joint).cost : 0;
        return continuity * 2 + direction * 0.4 + (index ? 0.12 : 0);
      };
      const locked = options.bendDirections?.[limb];
      const chosenIndex = locked === bendSide ? 0 : locked === -bendSide ? 1
        : jointScore(candidates[0], 0) <= jointScore(candidates[1], 1) ? 0 : 1;
      const joint = candidates[chosenIndex];
      pose.bendDirections ||= {};
      pose.bendDirections[limb] = chosenIndex === 0 ? bendSide : -bendSide;
      const upperResidual = Math.abs(Math.hypot(joint.x - root.x, joint.y - root.y) - a);
      const lowerResidual = Math.abs(Math.hypot(boneEndpoint.x - joint.x, boneEndpoint.y - joint.y) - b);
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
    if (!options.jointsOnly) extremities(pose, body, motion);
    if (motion) pose.motion = motion;
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
  return { DEFAULT_BODY, LIMBS, solve, poseAt, interpolate, lookup, segmentViolation, convexHull, outsideHullDistance, directionPenalty };
});
