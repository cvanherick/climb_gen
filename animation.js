/* Deterministic contact animation with continuous, contact-constrained poses. */
(function (root, factory) {
  const api = factory(root.ClimbGenIK || (typeof require === 'function' ? require('./ik') : null));
  root.ClimbGenAnimation = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(globalThis, (IK) => {
  const clamp = (x) => Math.max(0, Math.min(1, x));
  const ease = (x) => { x = clamp(x); return x * x * x * (10 + x * (-15 + x * 6)); };
  const mix = (a, b, t) => a + (b - a) * t;
  const signed = (value, limit) => Math.max(-limit, Math.min(limit, value));
  const wave = (t, start, peak, end) => t < peak
    ? ease((t - start) / (peak - start)) : 1 - ease((t - peak) / (end - peak));
  const trackedJoints = ['leftElbow', 'rightElbow', 'leftKnee', 'rightKnee', 'leftWrist', 'rightWrist',
    'leftAnkle', 'rightAnkle', 'leftHand', 'rightHand', 'leftFoot', 'rightFoot', 'pelvis', 'neck', 'head'];
  function jointTravel(a, b, key) {
    return Math.hypot(a.points[key].x - b.points[key].x, a.points[key].y - b.points[key].y, a.depth[key] - b.depth[key]);
  }
  function supportFootFor(segment, placements) {
    const limb = segment.step.limb;
    const otherFoot = limb.startsWith('left') ? 'rightFoot' : 'leftFoot';
    if (limb.endsWith('Foot')) return otherFoot;
    // Prefer the foothold underneath the intended weight transfer. At similar
    // distances, reaching off the same-side foot leaves a diagonal hand/foot base.
    const desiredX = mix(segment.startTorso.x, segment.to.x, 0.30);
    const footScore = key => {
      const foot = IK.lookup(placements, segment.contacts[key]);
      return Math.abs(foot.x - desiredX) + Math.max(0, foot.y - segment.startTorso.y) +
        (key === otherFoot ? 3 : 0);
    };
    return footScore('leftFoot') < footScore('rightFoot') ? 'leftFoot' : 'rightFoot';
  }
  function create(plan, placements, { overhangDeg = 40 } = {}) {
    if (!plan?.ok || !plan.initialPose || !plan.initialContacts) throw new Error('A contact plan is required for playback.');
    const segments = [];
    // Only one virtual endpoint changes per frame. Keep the installed board
    // immutable and avoid copying all of its placements for every joint sample.
    const frameMap = new Map(placements instanceof Map ? placements : Object.entries(placements));
    const wallAngle = overhangDeg * Math.PI / 180;
    const gravityDown = Math.cos(wallAngle), gravityOut = Math.sin(wallAngle);
    function hangingStance(body, stance) {
      const left = IK.lookup(placements, stance.leftFoot), right = IK.lookup(placements, stance.rightFoot);
      const leftHand = IK.lookup(placements, stance.leftHand), rightHand = IK.lookup(placements, stance.rightHand);
      const footCenter = (left.x + right.x) / 2;
      const spread = Math.max(12, Math.abs(right.x - left.x));
      const stagger = (right.y - left.y) / spread;
      // Stay low under the grips, but avoid collapsing into a deep sit
      // when the footholds already leave enough room to bend the knees.
      const feetHeight = Math.max(left.y, right.y);
      const y = body.y - gravityDown * (2 + 4 * clamp((body.y - feetHeight - 13) / 13));
      const depth = 7 + 17 * gravityOut + ((left.z || 0) + (right.z || 0)) / 2;
      const handHeight = (leftHand.y + rightHand.y) / 2;
      const hangDepth = (handHeight - y - IK.DEFAULT_BODY.torsoLength * 0.45) * gravityOut / Math.max(0.25, gravityDown);
      const restingDepth = depth + Math.max(-2, Math.min(6, 0.32 * (hangDepth - depth)));
      return {
        // In board coordinates gravity points down the wall and away from it.
        // Let the pelvis follow that direction, with the chest nearer the holds.
        y: Math.max(y, (4.5 + restingDepth * gravityOut) / Math.max(0.25, gravityDown)),
        x: body.x + signed((footCenter-body.x)*.23,7),
        depth: restingDepth,
        pitch: -0.45 * gravityOut,
        hipYaw: signed(-0.19 * stagger - (body.x - footCenter) * 0.004, 0.24),
        hipRoll: signed(0.35 * (body.hipTheta || 0) + 0.11 * stagger, 0.18),
      };
    }
    let contacts = { ...plan.initialContacts }, previous = plan.initialPose, total = 0;
    // Retain the contact plan's bend directions. Spatial playback keys the
    // actual elbow and knee planes along each move.
    const bends = { ...previous.bendDirections };
    for (const [index, step] of plan.steps.entries()) {
      const from = IK.contactAnchor(step.limb,IK.lookup(placements,contacts[step.limb]));
      const to = IK.contactAnchor(step.limb,IK.lookup(placements,step.id));
      const distance = Math.hypot(to.x - from.x, to.y - from.y);
      const bodyDistance = Math.hypot(step.pose.torso.x - previous.torso.x, step.pose.torso.y - previous.torso.y);
      const duration = Math.max(1250, Math.min(2800, 1000 + distance * 22 + bodyDistance * 15));
      const segment = { index, step, from, to, contacts: { ...contacts }, startTorso: { ...previous.torso }, endTorso: { ...step.pose.torso }, start: total, duration, arc: 0 };
      segment.supportFoot = supportFootFor(segment, placements);
      const stance = IK.lookup(placements, contacts[segment.supportFoot]);
      segment.weightShift = signed((stance.x - previous.torso.x) * 0.38, 5);
      segment.isHand = step.limb.endsWith('Hand');
      segment.side = step.limb.startsWith('left') ? -1 : 1;
      segment.stride = Math.min(1, distance / 26);
      segment.highStep = segment.isHand ? 0 : clamp((to.y - from.y) / 20);
      segment.before = hangingStance(segment.startTorso, contacts);
      segment.after = hangingStance(segment.endTorso, step.contacts);
      segment.rockOver = segment.highStep * signed((to.x - step.pose.torso.x) * 0.28, 3.5);
      segment.release = segment.isHand ? 0.24 : 0.27 + segment.highStep * 0.05;
      segment.catch = segment.isHand ? 0.81 : 0.76;
      // Straight contact interpolation can pass through a hip or shoulder,
      // folding the limb nearly to zero and spinning the joint. Search gentle
      // side arcs once, penalizing joint-limit violations and abrupt rotation.
      let bestCost = Infinity,bestCollision=Infinity;
      // Reduce body travel on tightly stretched stances. Keep the unshifted
      // trajectory available when any extra loading would overextend a limb.
      const jointKey = step.limb.replace('Hand', 'Elbow').replace('Foot', 'Knee');
      function pathCost(strength, amplitude, handDetour=0) {
        segment.strength = strength;
        segment.arc = segment.side * amplitude;
        segment.handDetour=handDetour;
        let cost = Math.abs(amplitude) * 0.12 + (amplitude < 0 ? 1 : 0) + (1 - strength) * 45 + Math.abs(handDetour)*.75;
        let peakResidual = 0, peakJointTravel = 0, peakCollision=0, prior = null;
        for (let i = 0; i <= 24; i++) {
          if (cost + peakResidual * 1500 >= bestCost) return {cost:Infinity};
          const pose = framePose(segment, i / 24, true);
          cost += pose.diagnostics.maxAngleViolationDeg ** 2 * 0.02 + pose.diagnostics.articulationCost * 1.2 + pose.diagnostics.maxSegmentResidual ** 2 * 100
            + pose.diagnostics.torsoCorrection ** 2 * 0.24 + 12*pose.diagnostics.bodyCollision;
          peakCollision=Math.max(peakCollision,pose.diagnostics.bodyCollision);
          if (i % 6 === 0) {
            const forces = IK.supportForces(pose, overhangDeg);
            cost += 18 * forces.forceResidual ** 2 + 0.03 * forces.torqueResidual ** 2;
          }
          peakResidual = Math.max(peakResidual, pose.diagnostics.maxSegmentResidual);
          if (prior) {
            cost += jointTravel(pose, prior, jointKey) ** 2 * 0.8;
            for (const key of trackedJoints) peakJointTravel = Math.max(peakJointTravel, jointTravel(pose, prior, key));
          }
          prior = pose;
        }
        return {cost:cost + peakResidual * 1500 + peakJointTravel ** 2 * 2,peakCollision};
      }
      let bestArc = 0, bestStrength = 0, bestDetour=0;
      function consider(strength,amplitude,detour) {
        const result=pathCost(strength,amplitude,detour);
        if(result.cost<bestCost) {
          bestCost=result.cost;bestCollision=result.peakCollision;
          bestArc=segment.arc;bestStrength=strength;bestDetour=detour;
        }
      }
      for (const strength of [1, 0.5, 0]) {
        for (const amplitude of [0, 6, -6, 14, -14, 24, -24]) consider(strength,amplitude,0);
      }
      if(segment.isHand && bestCollision>.35) {
        const currentArc=bestArc/segment.side,currentStrength=bestStrength;
        for(const detour of [-5,5,-9,9]) for(const arc of [currentArc,0]) consider(currentStrength,arc,detour);
      }
      segment.arc = bestArc;
      segment.strength = bestStrength;
      segment.handDetour=bestDetour;
      // Key the bend planes separately from the contact path. Smooth
      // the bend angle rather than the joint positions to preserve links.
      const bendsAt = Array.from({length:65},(_,i)=>framePose(segment,i/64,true).bendOffsets);
      segment.bendOffsets=bendsAt.map((entry,i)=>{
        if(!i || i===64)return entry;
        const first=Math.max(0,i-3),last=Math.min(64,i+3);
        return Object.fromEntries(Object.keys(IK.LIMBS).map(limb=>{
          let total=0,weight=0;
          for(let j=first;j<=last;j++) {
            const w=4-Math.abs(j-i);
            total+=bendsAt[j][limb]*w;weight+=w;
          }
          return [limb,total/weight];
        }));
      });
      let priorPose = framePose(segment, 0, true);
      const intervals = [];
      for (let i = 1; i <= 128; i++) {
        const nextPose = framePose(segment, i / 128, true);
        let interval = duration / 128;
        for (const key of trackedJoints) {
          const speedLimit = key === 'pelvis' ? 42 : key.endsWith('Foot') || key.endsWith('Knee') ? 66 : 84;
          interval = Math.max(interval, jointTravel(nextPose, priorPose, key) * 1000 / speedLimit);
        }
        intervals.push(interval);
        priorPose = nextPose;
      }
      // Slow the fast part of a move locally. Spread the added time over
      // adjacent intervals so one tight turn doesn't slow the entire reach.
      for (let i = 1; i < intervals.length; i++) intervals[i] = Math.max(intervals[i], intervals[i - 1] * .89);
      for (let i = intervals.length - 2; i >= 0; i--) intervals[i] = Math.max(intervals[i], intervals[i + 1] * .89);
      segment.frameTimes = [0];
      for (const interval of intervals) segment.frameTimes.push(segment.frameTimes.at(-1) + interval);
      segment.duration = segment.frameTimes.at(-1);
      segments.push(segment);
      total += segment.duration;
      contacts = { ...step.contacts };
      previous = step.pose;
    }
    function framePose(segment, t, jointsOnly = false) {
      const bodyT = ease(t), reachT = ease((t - segment.release) / (segment.catch - segment.release));
      const load = wave(t, 0, segment.release, segment.isHand ? 0.69 : 0.94);
      const drive = wave(t, segment.release * 0.6, segment.catch - 0.12, 1);
      const airborne = t > segment.release && t < segment.catch;
      const clearance = Math.sin(Math.PI * reachT) ** 2;
      const torso = {
        x: mix(segment.before.x,segment.after.x,bodyT),
        y: mix(segment.before.y,segment.after.y,bodyT),
        theta: mix(segment.startTorso.theta || 0,segment.endTorso.theta || 0,bodyT),
      };
      // Pelvis angles come from the two foot placements, including when a
      // hand moves. During a foot move turn into the new stance as it lands.
      const stanceT = segment.isHand ? bodyT : ease((t - segment.release) / (1 - segment.release));
      torso.hipTheta = mix(segment.before.hipRoll, segment.after.hipRoll, stanceT);
      const amount = segment.strength * segment.stride, side = segment.side;
      const rise = Math.tanh((segment.to.y - segment.from.y) / 12);
      torso.x += amount * segment.weightShift * (load + drive * 0.25);
      if (segment.isHand) {
        // Compress over the supporting shoe, then drive the reach from it.
        torso.y += amount * (-2.5 * load + 2 * drive * rise);
        torso.theta += amount * side * (0.06 * load + 0.17 * drive);
      } else {
        // Keep weight on the standing leg while the lifted hip and knee
        // rise. Only rock toward the higher toe after it makes contact.
        const transfer = wave(t, segment.catch, 0.89, 1);
        torso.x += amount * segment.rockOver * transfer;
        torso.y += amount * (0.9 * load + (1.2 + segment.highStep) * drive);
        torso.theta -= amount * side * 0.10 * load;
      }
      torso.theta = signed(torso.theta, IK.DEFAULT_BODY.torsoAngleLimit);
      torso.hipTheta = signed(torso.hipTheta, IK.DEFAULT_BODY.hipAngleLimit);
      const moving = airborne ? {
        x: mix(segment.from.x, segment.to.x, reachT) + segment.arc * clearance,
        y: mix(segment.from.y, segment.to.y, reachT) + clearance*(segment.isHand ? segment.handDetour : 3.2 * amount),
        z: mix(segment.from.z || 0, segment.to.z || 0, reachT)
          + (segment.isHand ? 2.4 : 2.4 + 1.2 * segment.highStep) * segment.stride * clearance,
      } : t <= segment.release ? segment.from : segment.to;
      if(airborne && segment.isHand && segment.from.gripPatch && segment.to.gripPatch) {
        moving.gripPatch={...moving,width:mix(segment.from.gripPatch.width,segment.to.gripPatch.width,reachT)};
      }
      frameMap.set('__moving_contact__', moving);
      const frameContacts = { ...segment.contacts, [segment.step.limb]: '__moving_contact__' };
      const motion = { movingLimb: segment.step.limb, supportFoot: segment.supportFoot, load, drive, airborne,
        grip: 1 - wave(t, segment.release - 0.07, segment.release + 0.12, segment.catch + 0.05),
        gazeTarget: segment.to, attention: wave(t, 0, segment.release, 1) };
      const sag = segment.isHand ? 0 : 4 * amount * clearance;
      torso.y -= gravityDown * sag;
      const hipYaw = mix(segment.before.hipYaw, segment.after.hipYaw, stanceT);
      const space = {
        depth: mix(segment.before.depth, segment.after.depth, bodyT)
          + gravityOut * sag - amount * (3.2 * load + 2.1 * drive * Math.max(0, rise)),
        pitch: mix(segment.before.pitch, segment.after.pitch, bodyT) - amount * 0.07 * drive,
        hipYaw,
        chestYaw: hipYaw * 0.65 - (segment.isHand ? side : 0) * 0.19 * amount * drive,
        swingSide: segment.isHand ? 0 : side,
        swing: clearance * segment.stride,
      };
      let bendOffsets;
      if(segment.bendOffsets) {
        const i=Math.min(63,Math.floor(t*64));
        const a=segment.bendOffsets[i],b=segment.bendOffsets[i+1],fraction=t*64-i;
        bendOffsets=Object.fromEntries(Object.keys(a).map(limb=>[limb,mix(a[limb],b[limb],fraction)]));
      }
      const pose=IK.poseAt(torso, frameContacts, frameMap, { bendDirections: bends, motion, jointsOnly, space, overhangDeg, bendOffsets });
      pose.contactIds=t<segment.catch?segment.contacts:segment.step.contacts;
      return pose;
    }
    function sample(elapsed = 0) {
      const time = Math.max(0, Math.min(total, elapsed));
      const segment = segments.find(s => time < s.start + s.duration) || segments.at(-1);
      if (!segment) return { pose: plan.initialPose, stepIndex: 0, done: true, phase: 'settle' };
      const localTime = time - segment.start;
      const times = segment.frameTimes;
      let low = 0, high = times.length - 1;
      while (high - low > 1) {
        const mid = (low + high) >> 1;
        if (times[mid] > localTime) high = mid;
        else low = mid;
      }
      const t = clamp((low + (localTime - times[low]) / (times[high] - times[low])) / (times.length - 1));
      const pose = framePose(segment, t);
      const phase = t < segment.release ? 'shift weight' : t < segment.catch
        ? segment.isHand ? 'reach' : 'place foot' : 'settle';
      return { pose, stepIndex: segment.index, done: time >= total, phase, elapsed: time };
    }
    return { sample, duration: total, segments };
  }
  // Playback time is independent of render frequency and survives pause/speed
  // changes without reconstructing the pose from the start of a contact move.
  function clock() {
    let elapsed = 0, last = null;
    return {
      reset(value = 0) { elapsed = value; last = null; },
      pause() { last = null; },
      tick(now, speed = 1) {
        if (last != null) elapsed += Math.min(100, Math.max(0, now - last)) * speed;
        last = now;
        return elapsed;
      },
      get elapsed() { return elapsed; },
    };
  }
  return { create, clock };
});
