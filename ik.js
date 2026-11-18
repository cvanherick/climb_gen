/* Board-plane contact search and optional spatial pose solving for playback. */
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
    pelvisTorsoAngleLimit: 0.18,
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
    if (torso.space) {
      const { depth, pitch, hipYaw, chestYaw } = torso.space;
      const yaw = spec.kind === 'leg' ? hipYaw : chestYaw;
      const width = offset[0] * Math.cos(yaw);
      const height = offset[1] * Math.cos(pitch) - offset[0] * Math.sin(yaw) * Math.sin(pitch);
      return {
        x: torso.x + width * Math.cos(rotation) - height * Math.sin(rotation),
        y: torso.y + width * Math.sin(rotation) + height * Math.cos(rotation),
        z: depth + offset[1] * Math.sin(pitch) + offset[0] * Math.sin(yaw) * Math.cos(pitch),
      };
    }
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
    if (torso.space) return shoeAt(contact, torso, body, sign).ankle;
    return { x: contact.x - sign * Math.cos(torso.hipTheta || 0) * body.footLength * 0.6, y: contact.y + 1.5 };
  }
  const distance = (a, b) => Math.hypot(b.x - a.x, b.y - a.y, (b.z || 0) - (a.z || 0));
  function shoeAt(toe, torso, body, side) {
    const { swingSide, swing } = torso.space;
    // A planted shoe retains its orientation as the pelvis moves. Rotate
    // the shoe during the swing, with a fixed toe and heel at either end.
    const roll = side * (0.22 + (side === swingSide ? 0.12 * swing : 0));
    const pitch = 0.44 + (side === swingSide ? 0.27 * swing : 0);
    const cosRoll = Math.cos(roll), sinRoll = Math.sin(roll);
    const cosPitch = Math.cos(pitch), sinPitch = Math.sin(pitch);
    const offset = (along, up, normal) => {
      const x = -side * (along * cosPitch - normal * sinPitch);
      return {
        x: toe.x + x * cosRoll - up * sinRoll,
        y: toe.y + x * sinRoll + up * cosRoll,
        z: (toe.z || 0) + along * sinPitch + normal * cosPitch,
      };
    };
    return { ankle: offset(body.footLength * 0.6, 1.5, 0.8), heel: offset(body.footLength, 0, 0) };
  }
  function jointAngleDeg(a, b, d) {
    const cosine = Math.max(-1, Math.min(1, (a * a + b * b - d * d) / (2 * a * b)));
    return Math.acos(cosine) * 180 / Math.PI;
  }
  function segmentViolation(a, b, d) {
    return Math.max(0, Math.abs(a - b) + 1.5 - d, d - (a + b - 1.5));
  }
  function twoBone(root, target, upper, lower, bendSide, outward = 0, knee = null) {
    const dx = target.x - root.x, dy = target.y - root.y, dz = (target.z || 0) - (root.z || 0);
    const raw = Math.max(1e-5, Math.hypot(dx, dy, dz));
    const d = Math.max(Math.abs(upper - lower) + 0.001, Math.min(upper + lower - 0.001, raw));
    const ux = dx / raw, uy = dy / raw, uz = dz / raw;
    const along = (upper * upper + d * d - lower * lower) / (2 * d);
    const across = Math.sqrt(Math.max(0, upper * upper - along * along));
    if (root.z != null) {
      if (knee) {
        const center = { x: root.x + ux * along, y: root.y + uy * along, z: root.z + uz * along };
        // Bend forward from the hip socket and keep left and right knee
        // hinges on their respective sides as the foot swings.
        const planar = Math.hypot(ux, uy);
        const nx = planar > .00001 ? ux / planar : 0;
        const ny = planar > .00001 ? uy / planar : -1;
        // Restrict the kneecap to the free side of the board. Stay on one
        // arc of the joint circle when that limits the usual bend direction.
        const wallward = -0.62 + knee.side * knee.yaw * 0.3;
        const clearance = (2.2 - center.z) / Math.max(0.00001, across * planar);
        const normal = Math.max(wallward, Math.min(1, clearance));
        const lateral = Math.sqrt(Math.max(0, 1 - normal ** 2)) * knee.side;
        return {
          x: center.x + across * (-normal * uz * nx - lateral * ny),
          y: center.y + across * (-normal * uz * ny + lateral * nx),
          z: center.z + across * normal * planar,
        };
      }
      // Rotate the bend plane out of the wall for the elbows, retaining
      // the path's selected left/right branch.
      const planar = Math.hypot(ux, uy);
      const nx = planar > 0.00001 ? ux / planar : 1;
      const ny = planar > 0.00001 ? uy / planar : 0;
      const sideways = Math.cos(outward) * bendSide, away = Math.sin(outward);
      return {
        x: root.x + ux * along + across * (-ny * sideways - nx * uz * away),
        y: root.y + uy * along + across * (nx * sideways - ny * uz * away),
        z: root.z + uz * along + across * planar * away,
      };
    }
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
      const d = distance(root, boneTarget);
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
        const handDepth = pose.depth?.[side + 'Hand'] || 0;
        const elbowDepth = pose.depth?.[side + 'Elbow'] || 0;
        const fraction = body.palmLength / Math.max(1e-6, distance({ ...elbow, z: elbowDepth }, { ...contact, z: handDepth }));
        const wrist = { x: contact.x + (elbow.x - contact.x) * fraction, y: contact.y + (elbow.y - contact.y) * fraction };
        pose.points[side + 'Wrist'] = wrist;
        if (pose.depth) pose.depth[side + 'Wrist'] = handDepth + (elbowDepth - handDepth) * fraction;
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
        let heel = { x: toe.x - sign * Math.cos(angle) * body.footLength, y: toe.y - 0.2 };
        let ankle;
        if (pose.depth) {
          const shoe = shoeAt({ ...toe, z: pose.depth[side + 'Foot'] }, pose.torso, body, sign);
          pose.depth[side + 'Heel'] = shoe.heel.z;
          pose.depth[side + 'Ankle'] = shoe.ankle.z;
          heel = { x: shoe.heel.x, y: shoe.heel.y };
          ankle = { x: shoe.ankle.x, y: shoe.ankle.y };
        } else ankle = limbTarget(side + 'Foot', toe, pose.torso, body);
        pose.points[side + 'Ankle'] = ankle; pose.points[side + 'Heel'] = heel; pose.points[side + 'Toe'] = { ...toe };
        pose.feet[side] = { ankle, heel, toe, knee };
      }
    }
  }
  function constrainTorso(torso, geometry, body, space, motion, overhangDeg, pitchAdjustments = 2) {
    const constrained = clampTorsoArticulation({ ...torso, space }, body);
    // Each planted hand or shoe defines a reach sphere for the pelvis.
    // Project in all three dimensions so an extended limb can draw the
    // hips in toward the wall as well as moving them up or across.
    const limits = geometry.targets.map(({ limb, target }) => {
      const contact = { ...target, z: target.z || 0 };
      const root = rootFor(limb, constrained, body);
      const end = limbTarget(limb, contact, constrained, body);
      const [upper, lower] = lengths(limb, body);
      const leg = LIMBS[limb].kind === 'leg';
      const kneeAngle = 122 - (limb === motion?.supportFoot ? 9 * (motion.load || 0) : 0);
      const flexed = Math.sqrt(upper ** 2 + lower ** 2 - 2 * upper * lower * Math.cos(kneeAngle * Math.PI / 180));
      return { x: torso.x + end.x - root.x, y: torso.y + end.y - root.y,
        z: space.depth + end.z - root.z, radius: upper + lower - 0.65, flexed: leg ? flexed : null };
    });
    let depth = space.depth;
    const wallAngle = overhangDeg * Math.PI / 180;
    const upY = Math.cos(wallAngle), upZ = -Math.sin(wallAngle);
    function clearFloor() {
      const correction = Math.max(0, 4.5 - constrained.y * upY - depth * upZ);
      constrained.y += upY * correction;
      depth += upZ * correction;
      return correction;
    }
    function project(limit, radius, weight) {
      const dx = constrained.x - limit.x, dy = constrained.y - limit.y, dz = depth - limit.z;
      const dist = Math.hypot(dx, dy, dz);
      if (dist <= radius) return 0;
      const correction = (dist - radius) * weight;
      constrained.x -= dx * correction / dist;
      constrained.y -= dy * correction / dist;
      depth -= dz * correction / dist;
      return correction;
    }
    // Bias the pose toward usable knee flexion. The final reach pass can
    // relax this preference when contacts span an unusually long stance.
    for (let iteration = 0; iteration < 9; iteration++) {
      for (const limit of limits) {
        if (limit.flexed) project(limit, limit.flexed, 0.5);
        project(limit, limit.radius, 1);
      }
      clearFloor();
    }
    for (let iteration = 0; iteration < 42; iteration++) {
      const reachCorrection = limits.reduce((sum, limit) => sum + project(limit, limit.radius, 1), 0);
      if (reachCorrection + clearFloor() < 0.001) break;
    }
    // On a long reach the pelvis can be drawn closer to the board. Ease
    // the lean in response so the chest does not disappear into the panel.
    const minPitch = Math.asin(Math.max(-0.9, Math.min(0.24, (3.4 - depth) / body.torsoLength)));
    if (pitchAdjustments && space.pitch < minPitch - 0.002) {
      return constrainTorso(torso, geometry, body, { ...space, pitch: minPitch }, motion, overhangDeg, pitchAdjustments - 1);
    }
    constrained.space = { ...space, depth };
    return constrained;
  }
  function clampTorsoArticulation(torso, body) {
    const theta = Math.max(-body.torsoAngleLimit, Math.min(body.torsoAngleLimit, torso.theta || 0));
    const hipLimit = Math.min(body.hipAngleLimit, body.pelvisTorsoAngleLimit ?? 0.18);
    const requestedHip = torso.hipTheta || 0;
    // Keep the pelvis and ribcage moving as one trunk. Allow a small amount of
    // pelvic counter-rotation for foot placements, but avoid a sharp waist kink.
    const hipTheta = Math.max(theta - hipLimit, Math.min(theta + hipLimit,
      Math.max(-body.hipAngleLimit, Math.min(body.hipAngleLimit, requestedHip))));
    return { ...torso, theta, hipTheta };
  }
  function keepHipsBelowHead(torso, body, overhangDeg, gaze, attention = 0) {
    const angle = overhangDeg * Math.PI / 180;
    const worldHeight = point => point.y * Math.cos(angle) - (point.z || 0) * Math.sin(angle);
    const clearance = candidate => {
      const pose = { ...torso, theta: candidate };
      const left = rootFor('leftFoot', pose, body), right = rootFor('rightFoot', pose, body);
      const a = rootFor('leftHand', pose, body), b = rootFor('rightHand', pose, body);
      const neck = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: ((a.z || 0) + (b.z || 0)) / 2 };
      const tilt = gaze ? Math.max(-0.32, Math.min(0.32,
        Math.atan2(gaze.x - neck.x, Math.max(12, gaze.y - neck.y)))) * attention : 0;
      const offset = body.headRadius * 1.65;
      const pitch = pose.space?.pitch || 0;
      const head = {
        y: neck.y + offset * Math.cos(pose.theta - tilt) * Math.cos(pitch),
        z: neck.z + offset * Math.sin(pitch),
      };
      return worldHeight(head) - Math.max(worldHeight(left), worldHeight(right));
    };
    const limit = body.torsoAngleLimit;
    if (clearance(torso.theta) >= 2.5) return torso;
    // A reach may ask for a pose that folds the torso upside down. Choose the
    // nearest legal torso angle that keeps both hip sockets clearly below the
    // head in world vertical, accounting for the board's 40° overhang.
    let best = 0, distance = Infinity;
    for (let i = 0; i <= 64; i++) {
      const candidate = -limit + 2 * limit * i / 64;
      if (clearance(candidate) >= 2.5 && Math.abs(candidate - torso.theta) < distance) {
        best = candidate;
        distance = Math.abs(candidate - torso.theta);
      }
    }
    return { ...torso, theta: best };
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
  function spatialCenterOfMass(points, depth) {
    const center = { x: 0, y: 0, z: 0 };
    let total = 0;
    const add = (a, b, mass) => {
      if (!points[a] || !points[b]) return;
      center.x += mass * (points[a].x + points[b].x) / 2;
      center.y += mass * (points[a].y + points[b].y) / 2;
      center.z += mass * (depth[a] + depth[b]) / 2;
      total += mass;
    };
    // Approximate segment masses for a center-of-mass marker during playback.
    add('pelvis', 'pelvis', 0.14);
    add('pelvis', 'neck', 0.36);
    add('head', 'head', 0.08);
    for (const side of ['left', 'right']) {
      add(side + 'Hip', side + 'Knee', 0.10);
      add(side + 'Knee', side + 'Foot', 0.06);
      add(side + 'Shoulder', side + 'Elbow', 0.03);
      add(side + 'Elbow', side + 'Hand', 0.02);
    }
    return { x: center.x / total, y: center.y / total, z: center.z / total };
  }
  function supportForces(pose, overhangDeg = 40) {
    const center = pose.diagnostics.centerOfMass;
    if (!pose.depth || !Number.isFinite(center.z)) return null;
    const wallAngle = overhangDeg * Math.PI / 180;
    const gravity = { x: 0, y: -Math.cos(wallAngle), z: Math.sin(wallAngle) };
    const torqueScale = 28; // Bring torques and forces onto comparable scales.
    const residual = [gravity.x, gravity.y, gravity.z, 0, 0, 0];
    const contacts = [];
    const basis = [];
    for (const [limb, spec] of Object.entries(LIMBS)) {
      if (pose.motion?.airborne && pose.motion.movingLimb === limb) continue;
      const point = pose.points[limb];
      if (!point) continue;
      const origin = { ...point, z: pose.depth[limb] };
      const force = { x: 0, y: 0, z: 0 };
      contacts.push({ limb, origin, force });
      const dx = origin.x - center.x, dy = origin.y - center.y, dz = origin.z - center.z;
      // Approximate reaction cones: toes push against the wall, hands
      // grip and pull. Coefficients stay nonnegative in both cones.
      // Include the upward reaction available on the top edge of a foothold.
      // A toe feature is treated as a ledge with a normal component, not a
      // shoe resting against a friction-only flat board.
      let directions;
      if (spec.kind === 'leg') {
        // A planted toe can push out from the wall and use the foothold edge
        // for upward or lateral support. The exact shoe/hold friction is
        // unknown, so keep this cone deliberately broad.
        directions = [[0, 0, 1], [0, 1, .12], [.48, .84, .35], [-.48, .84, .35], [0, -.30, 1]];
      } else {
        // Orient hand reactions to the actual forearm: the hold pushes on the
        // climber roughly from elbow toward hand. This makes each hand's
        // available pull direction follow its position, instead of giving
        // every hand the same arbitrary upward/wallward rays.
        const elbowKey = limb.replace('Hand', 'Elbow');
        const elbow = pose.points[elbowKey];
        const elbowDepth = pose.depth[elbowKey] || 0;
        let axis = elbow ? [origin.x - elbow.x, origin.y - elbow.y, origin.z - elbowDepth] : [0, 1, -1];
        const magnitude = Math.hypot(...axis) || 1;
        axis = axis.map(value => value / magnitude);
        // Reviewed hold-direction annotations describe the climber pulling
        // on the hold; reverse that vector for the reaction on the hand.
        // Use them only when explicitly reviewed, since inferred labels do
        // not establish a real grip direction or force capacity.
        const pull = pose.points[limb]?.profile?.verified ? pose.points[limb].profile.pull : null;
        if (pull && Math.hypot(pull.x || 0, pull.y || 0) > 0.01) {
          const profileReaction = [-(pull.x || 0), -(pull.y || 0), -0.35];
          const profileLength = Math.hypot(...profileReaction);
          axis = axis.map((value, i) => value * 0.7 + profileReaction[i] / profileLength * 0.3);
          const blendedLength = Math.hypot(...axis) || 1;
          axis = axis.map(value => value / blendedLength);
        }
        let side = [-axis[1], axis[0], 0];
        let sideLength = Math.hypot(...side);
        if (sideLength < 0.001) { side = [1, 0, 0]; sideLength = 1; }
        side = side.map(value => value / sideLength);
        const normal = [axis[1] * side[2] - axis[2] * side[1],
          axis[2] * side[0] - axis[0] * side[2], axis[0] * side[1] - axis[1] * side[0]];
        directions = [axis,
          axis.map((value, i) => value + .55 * side[i]),
          axis.map((value, i) => value - .55 * side[i]),
          axis.map((value, i) => value + .55 * normal[i]),
          axis.map((value, i) => value - .55 * normal[i])];
        directions = directions.map(ray => {
          const length = Math.hypot(...ray) || 1;
          return ray.map(value => value / length);
        });
      }
      for (const [x, y, z] of directions) {
        const column = [x, y, z, (dy * z - dz * y) / torqueScale,
          (dz * x - dx * z) / torqueScale, (dx * y - dy * x) / torqueScale];
        // Penalize each contact's resultant force to avoid large cancelling
        // reactions and solutions that depend on how many rays it has.
        const regularization = spec.kind === 'leg' ? 0.025 : 0.055;
        const norm = column.reduce((sum, value) => sum + value ** 2, 0.004)
          + regularization * (x ** 2 + y ** 2 + z ** 2);
        basis.push({ column, norm, regularization, coefficient: 0, force });
      }
    }
    for (let iteration = 0; iteration < 66; iteration++) {
      for (let i = 0; i < basis.length; i++) {
        const ray = basis[iteration % 2 ? basis.length - i - 1 : i];
        const [x, y, z] = ray.column;
        const { force } = ray;
        const loadCost = ray.regularization * (x * force.x + y * force.y + z * force.z);
        const projection = ray.column.reduce((sum, value, i) => sum + value * residual[i],
          0.004 * ray.coefficient + loadCost);
        const next = Math.max(0, ray.coefficient - projection / ray.norm);
        const change = next - ray.coefficient;
        for (let j = 0; j < residual.length; j++) residual[j] += change * ray.column[j];
        force.x += change * x;
        force.y += change * y;
        force.z += change * z;
        ray.coefficient = next;
      }
    }
    return { center, gravity, contacts, forceResidual: Math.hypot(...residual.slice(0, 3)),
      torqueResidual: Math.hypot(...residual.slice(3)) * torqueScale };
  }
  // Playback projects the requested pose onto the reach limits without
  // rerunning the planner's search for a preferred stance.
  function poseAt(torso, contacts, placements, options = {}) {
    const body = { ...DEFAULT_BODY, ...(options.body || {}) };
    const motion = options.motion;
    const requestedTorso = torso;
    const geometry = contactGeometry(contacts, placements, motion?.airborne ? motion.movingLimb : null);
    if (options.space) torso = constrainTorso(torso, geometry, body, options.space, motion, options.overhangDeg ?? 40);
    else torso = clampTorsoArticulation(torso, body);
    if (torso.space) torso = clampTorsoArticulation(keepHipsBelowHead(torso, body,
      options.overhangDeg ?? 40, motion?.gazeTarget, motion?.attention ?? 0), body);
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
        torsoCorrection: Math.hypot(torso.x - requestedTorso.x, torso.y - requestedTorso.y,
          (torso.space?.depth || 0) - (options.space?.depth || 0)),
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
    if (torso.space) pose.depth = { pelvis: torso.space.depth };
    const setPoint = (key, point) => {
      pose.points[key] = { x: point.x, y: point.y };
      if (pose.depth) pose.depth[key] = point.z || 0;
    };
    // The shoulder line is represented by both arm roots. The torso line ends at
    // the midpoint between shoulders; lower/upper joints use exact link lengths.
    const leftShoulder = rootFor('leftHand', torso, body), rightShoulder = rootFor('rightHand', torso, body);
    setPoint('leftShoulder', leftShoulder);
    setPoint('rightShoulder', rightShoulder);
    pose.points.neck = { x: (leftShoulder.x + rightShoulder.x) / 2, y: (leftShoulder.y + rightShoulder.y) / 2 };
    const gaze = motion?.gazeTarget;
    const headTilt = gaze ? Math.max(-0.32, Math.min(0.32,
      Math.atan2(gaze.x - pose.points.neck.x, Math.max(12, gaze.y - pose.points.neck.y)))) * motion.attention : 0;
    const headOffset = body.headRadius * 1.65;
    const headProjection = headOffset * Math.cos(torso.space?.pitch || 0);
    pose.points.head = {
      x: pose.points.neck.x - Math.sin(torso.theta - headTilt) * headProjection,
      y: pose.points.neck.y + Math.cos(torso.theta - headTilt) * headProjection,
    };
    if (pose.depth) {
      pose.depth.neck = (leftShoulder.z + rightShoulder.z) / 2;
      pose.depth.head = pose.depth.neck + headOffset * Math.sin(torso.space.pitch);
    }
    setPoint('leftHip', rootFor('leftFoot', torso, body));
    setPoint('rightHip', rootFor('rightFoot', torso, body));
    let maxSegmentResidual = 0;
    for (const limb of Object.keys(LIMBS)) {
      const id = contacts[limb];
      if (id == null) { pose.points[limb] = rootFor(limb, torso, body); continue; }
      const endpoint = lookup(placements, id);
      const root = rootFor(limb, torso, body), [a, b] = lengths(limb, body);
      const boneEndpoint = limbTarget(limb, endpoint, torso, body);
      const bendSide = LIMBS[limb].kind === 'arm' ? -LIMBS[limb].side : LIMBS[limb].side;
      const jointKey = limb.replace('Hand', 'Elbow').replace('Foot', 'Knee');
      const previousJoint = options.previousPose?.points?.[jointKey];
      const { kind, side } = LIMBS[limb];
      const outward = torso.space
        ? kind === 'arm' ? 0.58 - side * torso.space.chestYaw * 0.22 : 0.91 - side * torso.space.hipYaw * 0.35
        : 0;
      const knee = torso.space && kind === 'leg' ? { side, yaw: torso.space.hipYaw } : null;
      const primary = twoBone(root, boneEndpoint, a, b, bendSide, outward, knee);
      const candidates = [primary, knee ? primary : twoBone(root, boneEndpoint, a, b, -bendSide, outward)];
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
      const upperResidual = Math.abs(distance(root, joint) - a);
      const lowerResidual = Math.abs(distance(joint, boneEndpoint) - b);
      maxSegmentResidual = Math.max(maxSegmentResidual, upperResidual, lowerResidual);
      setPoint(limb, endpoint);
      if (endpoint.profile) pose.points[limb].profile = endpoint.profile;
      setPoint(jointKey, joint);
    }
    pose.diagnostics.maxSegmentResidual = maxSegmentResidual;
    pose.diagnostics.kinematic = pose.diagnostics.kinematic && maxSegmentResidual < 0.1;
    if (pose.depth) pose.diagnostics.centerOfMass = spatialCenterOfMass(pose.points, pose.depth);
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
  return { DEFAULT_BODY, LIMBS, solve, poseAt, interpolate, lookup, segmentViolation, convexHull, outsideHullDistance, directionPenalty, supportForces };
});
