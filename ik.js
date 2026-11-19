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
    palmLength: 1.5, fingerLength: 1.58, footLength: 3.4,

  });

  const LIMBS = Object.freeze({
    leftHand: { kind: 'arm', side: -1 }, rightHand: { kind: 'arm', side: 1 },
    leftFoot: { kind: 'leg', side: -1 }, rightFoot: { kind: 'leg', side: 1 },
  });
  const DEG = 180 / Math.PI;
  const RAD = Math.PI / 180;
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const vector = (a, b) => [b.x-a.x, b.y-a.y, (b.z||0)-(a.z||0)];
  const dot = (a, b) => a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
  const cross = ([x,y,z],[a,b,c]) => [y*c-z*b,z*a-x*c,x*b-y*a];
  const unit = v => {const length=Math.hypot(...v)||1; return v.map(x=>x/length);};
  const angleBetween = (u,v) => Math.atan2(Math.hypot(...cross(u,v)),dot(u,v))*DEG;
  const addScaled = (p, v, t) => ({x:p.x+v[0]*t,y:p.y+v[1]*t,z:(p.z||0)+v[2]*t});
  // Comfortable ranges for this avatar, with wider anatomical envelopes
  // for unusual moves. Angles at the elbow and knee are included angles.
  const JOINT_LIMITS = Object.freeze({
    shoulderElevation:[0,170,0,180], shoulderCross:[-37,32,-75,65],
    elbow:[66,162,35,180], wrist:[0,30,0,66],
    hipElevation:[0,105,0,129], hipExtension:[0,23,0,35], hipSide:[-25,40,-48,65],
    knee:[57,156,38,180], ankle:[-24,28,-55,42],
    spine:[0,28,0,46], neck:[0,18,0,45],
    fingerMCP:[0,71,0,90], fingerPIP:[0,92,0,108], fingerDIP:[0,65,0,80],
  });
  const FOOT_BELOW_HEAD = 5; // inches of clearance to any part of the shoe
  const PLANNING_HEADROOM = 11; // room for the pelvis to hang and toes to lift

  function lookup(placements, id) {
    return placements instanceof Map ? placements.get(String(id)) || placements.get(id) : placements[String(id)];
  }
  function contactAnchor(limb,point) {
    const patch=limb.endsWith('Hand') && point?.gripPatch;
    return patch ? {...point,x:patch.x,y:patch.y,z:patch.z} : point;
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
  function wristFlex(limb, contact, motion) {
    const open = motion?.movingLimb===limb ? 1-(motion.grip??1) : 0;
    const profile=contact?.profile;
    const sidePull=profile?.verified && !profile.unknown ? Math.abs(profile.pull?.x??0) : 0;
    return 11+sidePull*11+open*9;
  }
  function lengths(limb, body, contact, motion) {
    const wrist= LIMBS[limb].kind==='arm' ? wristFlex(limb,contact,motion) : 0;
    return LIMBS[limb].kind === 'arm'
      ? [body.upperArm, Math.hypot(body.lowerArm+body.palmLength*Math.cos(wrist*RAD),body.palmLength*Math.sin(wrist*RAD))]
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
    const { swingSide, swing } = torso.space || {};
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
  function bodyHead(torso,body,motion) {
    const pitch=torso.space?.pitch||0;
    const left=rootFor('leftHand',torso,body),right=rootFor('rightHand',torso,body);
    const neck={x:(left.x+right.x)/2,y:(left.y+right.y)/2,z:((left.z||0)+(right.z||0))/2};
    const gaze=motion?.gazeTarget;
    const tilt=gaze ? clamp(Math.atan2(gaze.x-neck.x,Math.max(12,gaze.y-neck.y)),-.32,.32)*(motion.attention??0) : 0;
    const offset=body.headRadius*1.65;
    const direction=torso.theta-tilt;
    const head=addScaled(neck,[-Math.sin(direction)*Math.cos(pitch),Math.cos(direction)*Math.cos(pitch),Math.sin(pitch)],offset);
    return {neck,head,tilt};
  }
  function jointAngleDeg(a, b, d) {
    const cosine = Math.max(-1, Math.min(1, (a * a + b * b - d * d) / (2 * a * b)));
    return Math.acos(cosine) * 180 / Math.PI;
  }
  function segmentViolation(a, b, d) {
    return Math.max(0, Math.abs(a - b) + 1.5 - d, d - (a + b - 1.5));
  }
  function hipAngles(thigh,down,right,forward,side) {
    const vertical=dot(thigh,down),ahead=dot(thigh,forward);
    const extension=Math.asin(Math.max(0,-ahead))*DEG;
    // Measure elevation in 3D. A wide lateral stance can make the
    // sagittal projection vanish and suggest a false 180-degree fold.
    const elevation=Math.acos(clamp(vertical,-1,1))*DEG;
    return {elevation,extension,side:Math.asin(clamp(side*dot(thigh,right),-1,1))*DEG};
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
        const center = addScaled(root,[ux,uy,uz],along);
        // Transport the wall axes to the leg chord. This stays continuous
        // when a planted toe passes directly below its hip in the board view.
        const denom=Math.max(.001,1-uz);
        const sideAxis=[1-ux*ux/denom,-ux*uy/denom,ux];
        const upAxis=[-ux*uy/denom,1-uy*uy/denom,uy];
        // A high foot needs room for the knee to open sideways and down.
        // A low foot can use more upward knee travel before the next step.
        const restPhase=Math.atan2(-.26-.55*uy,knee.side*.75)+knee.yaw*.35;
        const onCircle=phase=>addScaled(center,
          sideAxis.map((v,i)=>v*Math.cos(phase)+upAxis[i]*Math.sin(phase)),across);
        const {down,right,forward}=knee.frame;
        const loss=phase=>{
          const point=onCircle(phase);
          const thigh=unit(vector(root,point));
          const ahead=dot(thigh,forward),vertical=dot(thigh,down),lateral=knee.side*dot(thigh,right);
          const ankle=90-angleBetween(vector(target,point),knee.shoeAxis);
          const behind=Math.max(0,-ahead-.43);
          const folded=Math.max(0,-vertical-.36);
          const spread=Math.max(0,-lateral-.58,lateral-.75);
          const ankleExcess=Math.max(0,-37-ankle,ankle-35)/30;
          const closeToWall=Math.max(0,2.2-point.z);
          const lowKnee=Math.max(0,1.6-point.y*knee.upY+point.z*knee.upZ);
          return 6*behind**2+14*folded**2+5*spread**2+ankleExcess**2+.24*(phase-restPhase)**2
            +.25*closeToWall**2+.25*lowKnee**2;
        };
        // Slide the kneecap along its analytic joint circle, preserving
        // both bone lengths and the planted shoe.
        let phase=restPhase+(knee.offset??0);
        if(knee.offset==null) {
          for(let i=0;i<8;i++) {
            const slope=(loss(phase+.025)-loss(phase-.025))/.05;
            phase=clamp(phase-clamp(slope*.04,-.10,.10),restPhase-1.25,restPhase+1.25);
          }
        }
        return {...onCircle(phase),bendOffset:phase-restPhase};
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
  function contactGeometry(contacts, placements, airborneLimb = null, spatial = false) {
    const targets = [], anchors = [];
    for (const [limb, id] of Object.entries(contacts)) {
      if (id == null) continue;
      const point=lookup(placements,id);
      const target=spatial ? contactAnchor(limb,point) : point;
      targets.push({ limb, target });
      if (target && limb !== airborneLimb) anchors.push({ x: target.x, y: target.y });
    }
    return { targets, hull: convexHull(anchors), count: anchors.length };
  }
  function scoreTorso(torso, geometry, previous, body, overhangDeg) {
    let reachSquared = 0, angleSquared = 0, maxReachViolation = 0, maxAngleViolation = 0;
    let directionCost = 0, directionContacts = 0, reviewedContacts = 0, footDifficultyCost = 0, handDifficultyCost = 0;
    let maxFootHeightViolation = 0;
    // Leave room for the hips to hang farther out in spatial playback.
    const headY=torso.y+(body.torsoLength+body.headRadius*1.65)*Math.cos(torso.theta);
    for (const { limb, target } of geometry.targets) {
      if (!target) return { cost: Infinity, maxReachViolation: Infinity, maxAngleViolation: Infinity };
      const root = rootFor(limb, torso, body), [a, b] = lengths(limb, body, target);
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
      if (LIMBS[limb].kind === 'leg') {
        footDifficultyCost += spectrum?.footDifficulty(target, root).cost || 0;
        maxFootHeightViolation=Math.max(maxFootHeightViolation,
          boneTarget.y+(torso.space?FOOT_BELOW_HEAD:PLANNING_HEADROOM)-headY);
        angleSquared+=.26*(Math.max(0,boneTarget.y-root.y-2)/9)**2;
      }
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
      cost: reachSquared * 12 + angleSquared * 4 + supportCost * 2.4 + effort * 0.12 + orientationCost + directionCost * 3 + footDifficultyCost * 0.35 + handDifficultyCost * 0.25 + maxFootHeightViolation ** 2 * 20,
      maxReachViolation, maxAngleViolation, supportCost, directionCost, footDifficultyCost, handDifficultyCost, directionContacts, reviewedContacts, com, hull,
      maxFootHeightViolation,
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
  function digitAngles(digit,grip,width=4) {
    const small=clamp((3.5-width)/2.5,0,1);
    return digit===0 ? [18+20*grip,15+21*grip,8+10*grip] :
      [10+(41-20*small)*grip,9+(57+21*small)*grip,6+(27-12*small)*grip];
  }
  function extremities(pose, body, motion, jointsOnly) {
    pose.hands = {}; pose.feet = {};
    for (const side of ['left', 'right']) {
      const sign = side === 'left' ? -1 : 1;
      const contact = pose.points[side + 'Hand'], elbow = pose.points[side + 'Elbow'];
      const toe = pose.points[side + 'Foot'], knee = pose.points[side + 'Knee'];
      if (contact && elbow) {
        const grip = motion?.movingLimb === side + 'Hand' ? clamp(motion.grip??1,0,1) : 1;
        const hand3d={...contact,z:pose.depth?.[side+'Hand']};
        const wrist = twoBone({...elbow,z:pose.depth?.[side+'Elbow']},hand3d,body.lowerArm,body.palmLength,sign,-.72);
        pose.points[side + 'Wrist'] = {x:wrist.x,y:wrist.y};
        if (pose.depth) pose.depth[side + 'Wrist'] = wrist.z;
        const fingers = [];
        const width=pose.gripPatches?.[side+'Hand']?.width;
        const flexion=Array.from({length:5},(_,digit)=>digitAngles(digit,grip,width));
        if (!jointsOnly) {
          const palm=unit(vector(wrist,hand3d));
          const across=unit(Math.hypot(palm[0],palm[1])>.001?[-palm[1],palm[0],0]:[1,0,0]);
          const inward=unit(cross(across,palm));
          for (const [digit,angles] of flexion.entries()) {
            const spread=(digit-2)*(Math.min(.28,(width??3)/6)+(1-grip)*.12);
            const base=addScaled(addScaled(hand3d,palm,-.56),across,spread);
            const length=body.fingerLength*(digit===0?.7:digit===2?1:.86);
            const chain=[base];
            let angle=0;
            for(const [i,fraction] of [.44,.33,.23].entries()) {
              angle+=angles[i]*RAD;
              const direction=palm.map((u,k)=>u*Math.cos(angle)+inward[k]*Math.sin(angle));
              chain.push(addScaled(chain.at(-1),direction,length*fraction));
            }
            fingers.push(chain);
          }
        }
        pose.hands[side] = { wrist, contact, fingers, flexion };
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
  function articulation(pose,headTilt,overhangDeg) {
    const angles={}, outside={};
    let comfort=0;
    const add=(name,type,value)=>{
      const [min,max,hardMin,hardMax]=JOINT_LIMITS[type];
      angles[name]=value;
      if(value<hardMin || value>hardMax) outside[name]=Math.max(hardMin-value,value-hardMax);
      comfort+=(Math.max(0,min-value,value-max)/25)**2;
    };
    const p=name=>({...pose.points[name],z:pose.depth?.[name]});
    const up=unit(vector(p('pelvis'),p('neck')));
    const chestRight=unit(vector(p('leftShoulder'),p('rightShoulder')));
    const hipRight=unit(vector(p('leftHip'),p('rightHip')));
    const hipForward=unit(cross(up,hipRight));
    const down=up.map(x=>-x);
    const height=point=>point.y*Math.cos(overhangDeg*RAD)-(point.z||0)*Math.sin(overhangDeg*RAD);
    let footClearance=Infinity;
    add('spine','spine', Math.hypot(pose.torso.theta-(pose.torso.hipTheta||0),
      (pose.torso.space?.chestYaw||0)-(pose.torso.space?.hipYaw||0),pose.torso.space?.pitch||0)*DEG);
    add('neck','neck',Math.abs(headTilt)*DEG);
    for(const side of ['left','right']) {
      const sign=side==='left'?-1:1;
      const name=joint=>side+joint;
      if(pose.hands[side]) {
        const shoulder=p(name('Shoulder')),elbow=p(name('Elbow')),wrist=p(name('Wrist')),hand=p(name('Hand'));
        const arm=unit(vector(shoulder,elbow));
        add(name('ShoulderElevation'),'shoulderElevation',angleBetween(down,arm));
        add(name('ShoulderCross'),'shoulderCross',Math.asin(clamp(-sign*dot(chestRight,arm),-1,1))*DEG);
        add(name('Elbow'),'elbow',angleBetween(vector(elbow,shoulder),vector(elbow,wrist)));
        add(name('Wrist'),'wrist',angleBetween(vector(elbow,wrist),vector(wrist,hand)));
        for(const [i,flexion] of pose.hands[side].flexion.entries()) {
          for(const [j,joint] of ['MCP','PIP','DIP'].entries()) {
            const jointName=i===0?'Thumb'+['CMC','MCP','IP'][j]:'Digit'+i+joint;
            add(name(jointName),'finger'+joint,flexion[j]);
          }
        }
      }
      if(pose.feet[side]) {
        const hip=p(name('Hip')),knee=p(name('Knee')),ankle=p(name('Ankle')),toe=p(name('Foot')),heel=p(name('Heel'));
        const thigh=unit(vector(hip,knee));
        const hipMotion=hipAngles(thigh,down,hipRight,hipForward,sign);
        add(name('HipElevation'),'hipElevation',hipMotion.elevation);
        add(name('HipExtension'),'hipExtension',hipMotion.extension);
        add(name('HipSide'),'hipSide',hipMotion.side);
        add(name('Knee'),'knee',angleBetween(vector(knee,hip),vector(knee,ankle)));
        add(name('Ankle'),'ankle',90-angleBetween(vector(ankle,knee),vector(heel,toe)));
        for(const part of [toe,heel,ankle]) footClearance=Math.min(footClearance,p('head').y-part.y,height(p('head'))-height(part));
      }
    }
    return {angles,outside,comfort,footClearance,maxViolation:Math.max(0,...Object.values(outside))};
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
      const [upper, lower] = lengths(limb, body, target, motion);
      const leg = LIMBS[limb].kind === 'leg';
      const kneeAngle = 122 - (limb === motion?.supportFoot ? 9 * (motion.load || 0) : 0);
      const reach = degrees=>Math.sqrt(upper ** 2 + lower ** 2 - 2 * upper * lower * Math.cos(degrees*RAD));
      return { x: torso.x + end.x - root.x, y: torso.y + end.y - root.y,
        z: space.depth + end.z - root.z, radius: upper + lower - 0.65,
        minRadius:reach(JOINT_LIMITS[leg?'knee':'elbow'][2]+1), flexed: leg ? reach(kneeAngle) : null };
    });
    let depth = space.depth;
    const wallAngle = overhangDeg * Math.PI / 180;
    const upY = Math.cos(wallAngle), upZ = -Math.sin(wallAngle);
    const height = p => p.y*upY+(p.z||0)*upZ;
    // Use the lowest possible gaze within the current neck angle so later
    // torso projection cannot invalidate the clearance through a head turn.
    const head=bodyHead(constrained,body).head;
    head.y-=body.headRadius*1.65*(Math.cos(constrained.theta)-Math.cos(Math.abs(constrained.theta)+.32*(motion?.attention??0)));
    const offsetY=head.y-torso.y, offsetHeight=height(head)-height({y:torso.y,z:depth});
    let minY=-Infinity,minHeight=4.5;
    for(const {limb,target} of geometry.targets) if (LIMBS[limb].kind==='leg') {
      const shoe=shoeAt(target,constrained,body,LIMBS[limb].side);
      for(const point of [target,shoe.heel,shoe.ankle]) {
        minY=Math.max(minY,point.y+FOOT_BELOW_HEAD-offsetY);
        minHeight=Math.max(minHeight,height(point)+FOOT_BELOW_HEAD-offsetHeight);
      }
    }
    function clearFloor() {
      const boardCorrection=Math.max(0,minY-constrained.y);
      constrained.y+=boardCorrection;
      const correction = Math.max(0, minHeight - constrained.y * upY - depth * upZ);
      constrained.y += upY * correction;
      depth += upZ * correction;
      return correction+boardCorrection;
    }
    function project(limit, radius, weight, minimum=false) {
      const dx = constrained.x - limit.x, dy = constrained.y - limit.y, dz = depth - limit.z;
      const dist = Math.hypot(dx, dy, dz);
      if (minimum ? dist>=radius : dist<=radius) return 0;
      if (dist<1e-8) {constrained.y+=radius*weight;return radius*weight;}
      const correction = (dist - radius) * weight;
      constrained.x -= dx * correction / dist;
      constrained.y -= dy * correction / dist;
      depth -= dz * correction / dist;
      return Math.abs(correction);
    }
    // Bias the pose toward usable knee flexion. The final reach pass can
    // relax this preference when contacts span an unusually long stance.
    for (let iteration = 0; iteration < 9; iteration++) {
      for (const limit of limits) {
        if (limit.flexed) project(limit, limit.flexed, 0.5);
        project(limit,limit.minRadius,.65,true);
        project(limit, limit.radius, 1);
      }
      clearFloor();
    }
    for (let iteration = 0; iteration < 42; iteration++) {
      const reachCorrection = limits.reduce((sum, limit) =>
        sum + project(limit,limit.minRadius,.7,true) + project(limit,limit.radius,1),0);
      if (reachCorrection + clearFloor() < 0.001) break;
    }
    // On a long reach the pelvis can be drawn closer to the board. Ease
    // the lean in response so the chest does not disappear into the panel.
    const minPitch = Math.asin(Math.max(-0.9, Math.min(0.24, (3.4 - depth) / body.torsoLength)));
    if (pitchAdjustments && space.pitch < minPitch - 0.002) {
      return constrainTorso(torso, geometry, body, { ...space, pitch: minPitch }, motion, overhangDeg, pitchAdjustments - 1);
    }
    constrained.space = { ...constrained.space, depth };
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
    const space=torso.space;
    if (!space) return { ...torso, theta, hipTheta };
    const hipYaw=clamp(space.hipYaw||0,-.3,.3);
    const chestYaw=clamp(space.chestYaw||0,hipYaw-.25,hipYaw+.25);
    const pitchLimit=Math.sqrt((JOINT_LIMITS.spine[3]*RAD)**2-(theta-hipTheta)**2-(chestYaw-hipYaw)**2);
    return { ...torso, theta, hipTheta, space:{...space,hipYaw,chestYaw,
      pitch:clamp(space.pitch||0,-Math.min(.72,pitchLimit),.24)} };
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
  function supportForces(pose, overhangDeg = 40, previousContacts = null, scenario) {
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
      const origin = { x: point.x, y: point.y, z: pose.depth[limb] };
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
      } else if (!pose.points[limb.replace('Hand', 'Elbow')]) {
        directions = [[0, .20, -1], [0, 1, -.20], [.72, .70, -.63], [-.72, .70, -.63]];
      } else {
        // Orient hand reactions to the actual forearm: the hold pushes on the
        // climber roughly from elbow toward hand. This makes each hand's
        // available pull direction follow its position, instead of giving
        // every hand the same arbitrary upward/wallward rays.
        const elbowKey = limb.replace('Hand', 'Elbow');
        const elbow = pose.points[elbowKey];
        const elbowDepth = pose.depth[elbowKey] || 0;
        let axis = [origin.x - elbow.x, origin.y - elbow.y, Math.min(-.025, origin.z - elbowDepth)];
        const magnitude = Math.hypot(...axis) || 1;
        axis = axis.map(value => value / magnitude);
        const shoulderKey=limb.replace('Hand','Shoulder');
        const shoulder=pose.points[shoulderKey];
        if(shoulder) {
          const upper=unit(vector({...shoulder,z:pose.depth[shoulderKey]},origin));
          axis=unit(axis.map((v,i)=>v*.76+upper[i]*.24));
        }
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
        const fingers=pose.hands?.[limb.startsWith('left')?'left':'right']?.flexion;
        const fingerClosure=(fingers?.[2]?.[1]??65)/90;
        const edgeWidth=pose.gripPatches?.[limb]?.width;
        // The hand posture only steers the directional prior. It says
        // nothing about a particular climber's strength or grip capacity.
        const spread=clamp(.65-.13*fingerClosure-.03*Math.max(0,3-(edgeWidth??3))+(scenario?.spread??0),.3,.8);
        directions = [axis,
          axis.map((value, i) => value + spread * side[i]),
          axis.map((value, i) => value - spread * side[i]),
          axis.map((value, i) => value + spread * normal[i]),
          axis.map((value, i) => value - spread * normal[i])];
        directions = directions.map(ray => {
          ray[2] = Math.min(-.001, ray[2]);
          const length = Math.hypot(...ray) || 1;
          return ray.map(value => value / length);
        });
      }
      for (const [x, y, z] of directions) {
        const column = [x, y, z, (dy * z - dz * y) / torqueScale,
          (dz * x - dx * z) / torqueScale, (dx * y - dy * x) / torqueScale];
        // Penalize each contact's resultant force to avoid large cancelling
        // reactions and solutions that depend on how many rays it has.
        const regularization = (spec.kind === 'leg' ? 0.025 : 0.055)*(scenario?.limb===limb?scenario.effort:1);
        const previous = previousContacts?.find(contact => contact.limb === limb)?.force;
        const continuity = previous ? .07 : 0;
        const norm = column.reduce((sum, value) => sum + value ** 2, 0.004)
          + (regularization + continuity) * (x ** 2 + y ** 2 + z ** 2);
        const priorProjection = previous ? x*previous.x + y*previous.y + z*previous.z : 0;
        basis.push({ column, norm, regularization, continuity, priorProjection, coefficient: 0, force });
      }
    }
    for (let iteration = 0; iteration < 66; iteration++) {
      for (let i = 0; i < basis.length; i++) {
        const ray = basis[iteration % 2 ? basis.length - i - 1 : i];
        const [x, y, z] = ray.column;
        const { force } = ray;
        const loadCost = (ray.regularization + ray.continuity) * (x * force.x + y * force.y + z * force.z)
          - ray.continuity * ray.priorProjection;
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
    // Rebuild from the nonnegative coefficients. Incremental updates can
    // leave a tiny reaction with the wrong sign when a contact unloads.
    for(const {force} of contacts) force.x=force.y=force.z=0;
    for(const {force,column,coefficient} of basis) {
      force.x+=column[0]*coefficient;
      force.y+=column[1]*coefficient;
      force.z+=column[2]*coefficient;
    }
    return { center, gravity, contacts, forceResidual: Math.hypot(...residual.slice(0, 3)),
      torqueResidual: Math.hypot(...residual.slice(3)) * torqueScale };
  }
  function usableBalance(balance) {
    return Boolean(balance && balance.contacts.length>=2 && balance.forceResidual<=.16 && balance.torqueResidual<=4
      && balance.contacts.every(({force})=>Math.hypot(force.x,force.y,force.z)<=2));
  }
  function forceRanges(pose, balance=supportForces(pose), overhangDeg=40) {
    if(!usableBalance(balance)) return null;
    const magnitude=({force})=>100*Math.hypot(force.x,force.y,force.z);
    const rows=balance.contacts.map(c=>({limb:c.limb,percent:magnitude(c),min:magnitude(c),max:magnitude(c)}));
    let scenarios=1;
    for(const {limb} of balance.contacts) for(const effort of [.15,4]) {
      const trial=supportForces(pose,overhangDeg,null,{limb,effort,spread:effort<1?.12:-.06});
      if(!usableBalance(trial)) continue;
      scenarios++;
      for(const [i,c] of trial.contacts.entries()) {
        const percent=magnitude(c);
        rows[i].min=Math.min(rows[i].min,percent);
        rows[i].max=Math.max(rows[i].max,percent);
      }
    }
    return {rows,scenarios};
  }
  // Playback projects the requested pose onto the reach limits without
  // rerunning the planner's search for a preferred stance.
  function poseAt(torso, contacts, placements, options = {}) {
    const body = { ...DEFAULT_BODY, ...(options.body || {}) };
    const motion = options.motion;
    const requestedTorso = torso;
    const geometry = contactGeometry(contacts, placements, motion?.airborne ? motion.movingLimb : null,Boolean(options.space));
    if (options.space) torso = constrainTorso(torso, geometry, body, options.space, motion, options.overhangDeg ?? 40);
    else torso = clampTorsoArticulation(torso, body);
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
        maxFootHeightViolation: diagnostics.maxFootHeightViolation,
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
    const {neck,head,tilt}=bodyHead(torso,body,motion);
    setPoint('neck',neck);
    setPoint('head',head);
    setPoint('leftHip', rootFor('leftFoot', torso, body));
    setPoint('rightHip', rootFor('rightFoot', torso, body));
    const pelvisRight=unit(vector(rootFor('leftFoot',torso,body),rootFor('rightFoot',torso,body)));
    const trunkUp=unit(vector({...pose.points.pelvis,z:pose.depth?.pelvis},neck));
    const hipFrame={down:trunkUp.map(x=>-x),right:pelvisRight,forward:unit(cross(trunkUp,pelvisRight))};
    let maxSegmentResidual = 0;
    for (const limb of Object.keys(LIMBS)) {
      const id = contacts[limb];
      if (id == null) { pose.points[limb] = rootFor(limb, torso, body); continue; }
      const point=lookup(placements,id);
      const endpoint=options.space?contactAnchor(limb,point):point;
      const root = rootFor(limb, torso, body), [a, b] = lengths(limb, body, endpoint, motion);
      const boneEndpoint = limbTarget(limb, endpoint, torso, body);
      const bendSide = LIMBS[limb].kind === 'arm' ? -LIMBS[limb].side : LIMBS[limb].side;
      const jointKey = limb.replace('Hand', 'Elbow').replace('Foot', 'Knee');
      const previousJoint = options.previousPose?.points?.[jointKey];
      const { kind, side } = LIMBS[limb];
      const outward = torso.space
        ? kind === 'arm' ? 0.58 - side * torso.space.chestYaw * 0.22 : 0.91 - side * torso.space.hipYaw * 0.35
        : 0;
      const knee = torso.space && kind === 'leg'
        ? {side,yaw:torso.space.hipYaw,frame:hipFrame,shoeAxis:vector(shoeAt(endpoint,torso,body,side).heel,endpoint),
          upY:Math.cos((options.overhangDeg??40)*RAD),upZ:Math.sin((options.overhangDeg??40)*RAD),offset:options.kneeOffsets?.[limb]}
        : null;
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
      if(knee) {
        pose.kneeOffsets??={};
        pose.kneeOffsets[limb]=joint.bendOffset;
      }
      pose.bendDirections ||= {};
      pose.bendDirections[limb] = chosenIndex === 0 ? bendSide : -bendSide;
      const upperResidual = Math.abs(distance(root, joint) - a);
      const lowerResidual = Math.abs(distance(joint, boneEndpoint) - b);
      maxSegmentResidual = Math.max(maxSegmentResidual, upperResidual, lowerResidual);
      setPoint(limb, endpoint);
      if (endpoint.profile) pose.points[limb].profile = endpoint.profile;
      if(endpoint.gripPatch) {
        pose.gripPatches??={};
        pose.gripPatches[limb]=endpoint.gripPatch;
      }
      setPoint(jointKey, joint);
    }
    pose.diagnostics.maxSegmentResidual = maxSegmentResidual;
    extremities(pose, body, motion, options.jointsOnly);
    const joints=articulation(pose,tilt,options.overhangDeg??40);
    pose.diagnostics.jointAnglesDeg=joints.angles;
    pose.diagnostics.jointViolationsDeg=joints.outside;
    pose.diagnostics.articulationCost=joints.comfort;
    pose.diagnostics.footClearance=joints.footClearance;
    pose.diagnostics.maxAngleViolationDeg=joints.maxViolation;
    pose.diagnostics.kinematic = pose.diagnostics.reachable && maxSegmentResidual < 0.1
      && joints.maxViolation<.1 && joints.footClearance>=FOOT_BELOW_HEAD-.001;
    if (pose.depth) pose.diagnostics.centerOfMass = spatialCenterOfMass(pose.points, pose.depth);
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
  return { DEFAULT_BODY, LIMBS, JOINT_LIMITS, FOOT_BELOW_HEAD, solve, poseAt, interpolate, lookup, contactAnchor, segmentViolation, convexHull, outsideHullDistance, directionPenalty, supportForces, usableBalance, forceRanges };
});
