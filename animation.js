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
  const trackedJoints = ['leftElbow', 'rightElbow', 'leftKnee', 'rightKnee', 'leftHand', 'rightHand', 'leftFoot', 'rightFoot', 'pelvis'];
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
  function create(plan, placements) {
    if (!plan?.ok || !plan.initialPose || !plan.initialContacts) throw new Error('A contact plan is required for playback.');
    const segments = [];
    // Only one virtual endpoint changes per frame. Keep the installed board
    // immutable and avoid copying all of its placements for every joint sample.
    const frameMap = new Map(placements instanceof Map ? placements : Object.entries(placements));
    let contacts = { ...plan.initialContacts }, previous = plan.initialPose, total = 0;
    // Keep the anatomical bend branch for the whole playback. A branch change
    // would need an explicitly planned straight-limb transition.
    const bends = { ...previous.bendDirections };
    for (const [index, step] of plan.steps.entries()) {
      const from = IK.lookup(placements, contacts[step.limb]), to = IK.lookup(placements, step.id);
      const distance = Math.hypot(to.x - from.x, to.y - from.y);
      const bodyDistance = Math.hypot(step.pose.torso.x - previous.torso.x, step.pose.torso.y - previous.torso.y);
      const duration = Math.max(1250, Math.min(2800, 1000 + distance * 22 + bodyDistance * 15));
      const segment = { index, step, from, to, contacts: { ...contacts }, startTorso: { ...previous.torso }, endTorso: { ...step.pose.torso }, start: total, duration, arc: 0 };
      segment.supportFoot = supportFootFor(segment, placements);
      const stance = IK.lookup(placements, contacts[segment.supportFoot]);
      segment.weightShift = signed((stance.x - previous.torso.x) * 0.38, 5);
      segment.supportSide = segment.supportFoot === 'leftFoot' ? -1 : 1;
      segment.isHand = step.limb.endsWith('Hand');
      segment.side = step.limb.startsWith('left') ? -1 : 1;
      segment.stride = Math.min(1, distance / 26);
      segment.highStep = segment.isHand ? 0 : clamp((to.y - from.y) / 20);
      segment.rockOver = segment.highStep * signed((to.x - step.pose.torso.x) * 0.28, 3.5);
      segment.release = segment.isHand ? 0.24 : 0.27 + segment.highStep * 0.05;
      segment.catch = segment.isHand ? 0.81 : 0.76;
      // Straight contact interpolation can pass through a hip or shoulder,
      // folding the limb nearly to zero and spinning the joint. Search gentle
      // side arcs once, penalizing joint-limit violations and abrupt rotation.
      let bestCost = Infinity;
      // Reduce body travel on tightly stretched stances. Keep the unshifted
      // trajectory available when any extra loading would overextend a limb.
      const jointKey = step.limb.replace('Hand', 'Elbow').replace('Foot', 'Knee');
      function pathCost(strength, amplitude) {
        segment.strength = strength;
        segment.arc = segment.side * amplitude;
        let cost = Math.abs(amplitude) * 0.12 + (amplitude < 0 ? 1 : 0) + (1 - strength) * 80;
        let peakResidual = 0, peakJointTravel = 0, prior = null;
        for (let i = 0; i <= 24; i++) {
          if (cost + peakResidual * 1500 >= bestCost) return Infinity;
          const pose = framePose(segment, i / 24, true);
          cost += pose.diagnostics.maxAngleViolationDeg ** 2 * 0.04 + pose.diagnostics.maxSegmentResidual ** 2 * 100
            + pose.diagnostics.torsoCorrection ** 2 * 0.24;
          peakResidual = Math.max(peakResidual, pose.diagnostics.maxSegmentResidual);
          if (prior) {
            cost += jointTravel(pose, prior, jointKey) ** 2 * 0.8;
            for (const key of trackedJoints) peakJointTravel = Math.max(peakJointTravel, jointTravel(pose, prior, key));
          }
          prior = pose;
        }
        return cost + peakResidual * 1500 + peakJointTravel ** 2 * 2;
      }
      let bestArc = 0, bestStrength = 0;
      for (const strength of [1, 0.5, 0]) {
        for (const amplitude of [0, 6, -6, 14, -14, 24, -24]) {
          const cost = pathCost(strength, amplitude);
          if (cost < bestCost) {
            bestCost = cost;
            bestArc = segment.arc;
            bestStrength = strength;
          }
        }
      }
      segment.arc = bestArc;
      segment.strength = bestStrength;
      let priorPose = framePose(segment, 0, true), requiredDuration = duration;
      for (let i = 1; i <= 64; i++) {
        const nextPose = framePose(segment, i / 64, true);
        for (const key of trackedJoints) {
          const speedLimit = key === 'pelvis' ? 42 : key.endsWith('Foot') || key.endsWith('Knee') ? 66 : 84;
          requiredDuration = Math.max(requiredDuration, jointTravel(nextPose, priorPose, key) * 64000 / speedLimit);
        }
        priorPose = nextPose;
      }
      segment.duration = requiredDuration;
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
      const torso = {};
      for (const key of ['x', 'y', 'theta', 'hipTheta']) torso[key] = mix(segment.startTorso[key] || 0, segment.endTorso[key] || 0, bodyT);
      const amount = segment.strength * segment.stride, side = segment.side;
      const rise = Math.tanh((segment.to.y - segment.from.y) / 12);
      torso.x += amount * segment.weightShift * (load + drive * 0.25);
      if (segment.isHand) {
        // Compress over the supporting shoe, then extend it and lead the
        // reach with the shoulder. The hips counter-rotate under the chest.
        torso.y += amount * (-2.5 * load + 2 * drive * rise);
        torso.theta += amount * side * (0.06 * load + 0.17 * drive);
        torso.hipTheta -= amount * side * (0.11 * load + 0.07 * drive);
      } else {
        // Keep weight on the standing leg while the lifted hip and knee
        // rise. Only rock toward the higher toe after it makes contact.
        const transfer = wave(t, segment.catch, 0.89, 1);
        torso.x += amount * segment.rockOver * transfer;
        torso.y += amount * (0.9 * load + (1.2 + segment.highStep) * drive);
        torso.hipTheta += amount * side * (0.12 * load + 0.14 * drive);
        torso.theta -= amount * side * 0.10 * load;
      }
      torso.theta = signed(torso.theta, IK.DEFAULT_BODY.torsoAngleLimit);
      torso.hipTheta = signed(torso.hipTheta, IK.DEFAULT_BODY.hipAngleLimit);
      const moving = airborne ? {
        x: mix(segment.from.x, segment.to.x, reachT) + segment.arc * clearance,
        y: mix(segment.from.y, segment.to.y, reachT) + (segment.isHand ? 0 : 3.2 * amount * clearance),
        z: (segment.isHand ? 2.4 : 3.5 + 1.5 * segment.highStep) * segment.stride * clearance,
      } : t <= segment.release ? segment.from : segment.to;
      frameMap.set('__moving_contact__', moving);
      const frameContacts = { ...segment.contacts, [segment.step.limb]: '__moving_contact__' };
      const motion = { movingLimb: segment.step.limb, supportFoot: segment.supportFoot, load, drive, airborne,
        grip: 1 - wave(t, segment.release - 0.07, segment.release + 0.12, segment.catch + 0.05),
        gazeTarget: segment.to, attention: wave(t, 0, segment.release, 1) };
      const space = {
        // The pelvis draws closer over the loaded toe. The reaching shoulder
        // opens independently as the supporting hip turns into the wall.
        depth: 8 + amount * (-2.5 * load - 1.5 * drive * Math.max(0, rise)),
        pitch: -0.06 - amount * 0.1 * drive,
        hipYaw: -segment.supportSide * amount * (0.31 * load + 0.36 * drive),
        chestYaw: amount * (segment.supportSide * 0.13 * load - (segment.isHand ? side : 0) * 0.42 * drive),
        swingSide: segment.isHand ? 0 : side,
        swing: clearance * segment.stride,
      };
      return IK.poseAt(torso, frameContacts, frameMap, { bendDirections: bends, motion, jointsOnly, space });
    }
    function sample(elapsed = 0) {
      const time = Math.max(0, Math.min(total, elapsed));
      const segment = segments.find(s => time < s.start + s.duration) || segments.at(-1);
      if (!segment) return { pose: plan.initialPose, stepIndex: 0, done: true, phase: 'settle' };
      const t = clamp((time - segment.start) / segment.duration);
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
