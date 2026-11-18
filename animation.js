/* Deterministic contact animation. Torso motion is planned once per action;
   rendering never re-optimizes the body or switches two-bone branches. */
(function (root, factory) {
  const api = factory(root.ClimbGenIK || (typeof require === 'function' ? require('./ik') : null));
  root.ClimbGenAnimation = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(globalThis, (IK) => {
  const clamp = (x) => Math.max(0, Math.min(1, x));
  const ease = (x) => { x = clamp(x); return x * x * x * (10 + x * (-15 + x * 6)); };
  const mix = (a, b, t) => a + (b - a) * t;
  const wave = (t, start, peak, end) => t < peak
    ? ease((t - start) / (peak - start)) : 1 - ease((t - peak) / (end - peak));
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
      segment.weightShift = Math.max(-5, Math.min(5, (stance.x - previous.torso.x) * 0.38));
      segment.isHand = step.limb.endsWith('Hand');
      segment.side = step.limb.startsWith('left') ? -1 : 1;
      segment.stride = Math.min(1, distance / 26);
      segment.release = segment.isHand ? 0.24 : 0.29;
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
        let peakResidual = 0, prior = null;
        for (let i = 0; i <= 24; i++) {
          if (cost + peakResidual * 1500 >= bestCost) return Infinity;
          const pose = framePose(segment, i / 24, true);
          cost += pose.diagnostics.maxAngleViolationDeg ** 2 * 0.04 + pose.diagnostics.maxSegmentResidual ** 2 * 100;
          peakResidual = Math.max(peakResidual, pose.diagnostics.maxSegmentResidual);
          const joint = pose.points[jointKey];
          if (prior) cost += Math.hypot(joint.x - prior.x, joint.y - prior.y) ** 2;
          prior = joint;
        }
        return cost + peakResidual * 1500;
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
      let priorPose = framePose(segment, 0, true), peakStep = 0;
      for (let i = 1; i <= 64; i++) {
        const nextPose = framePose(segment, i / 64, true);
        for (const key of ['leftElbow', 'rightElbow', 'leftKnee', 'rightKnee', 'leftHand', 'rightHand', 'leftFoot', 'rightFoot', 'pelvis']) {
          peakStep = Math.max(peakStep, Math.hypot(nextPose.points[key].x - priorPose.points[key].x, nextPose.points[key].y - priorPose.points[key].y));
        }
        priorPose = nextPose;
      }
      segment.duration = Math.max(duration, peakStep * 64 / 38 * 1000);
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
      torso.x += amount * segment.weightShift * (load + drive * 0.25);
      if (segment.isHand) {
        // Compress over the supporting shoe, then extend it and lead the
        // reach with the shoulder. The hips counter-rotate under the chest.
        torso.y += amount * (-2.5 * load + 2 * drive * Math.tanh((segment.to.y - segment.from.y) / 12));
        torso.theta += amount * side * (0.06 * load + 0.17 * drive);
        torso.hipTheta -= amount * side * (0.11 * load + 0.07 * drive);
      } else {
        // Keep weight on the standing leg while the lifted hip and knee
        // rise, then lower onto the new toe after it makes contact.
        torso.y += amount * (0.9 * load + 1.2 * drive);
        torso.hipTheta += amount * side * (0.12 * load + 0.14 * drive);
        torso.theta -= amount * side * 0.10 * load;
      }
      torso.theta = Math.max(-IK.DEFAULT_BODY.torsoAngleLimit, Math.min(IK.DEFAULT_BODY.torsoAngleLimit, torso.theta));
      torso.hipTheta = Math.max(-IK.DEFAULT_BODY.hipAngleLimit, Math.min(IK.DEFAULT_BODY.hipAngleLimit, torso.hipTheta));
      const moving = airborne ? {
        x: mix(segment.from.x, segment.to.x, reachT) + segment.arc * clearance,
        y: mix(segment.from.y, segment.to.y, reachT) + (segment.isHand ? 0 : 3.2 * amount * clearance),
      } : t <= segment.release ? segment.from : segment.to;
      frameMap.set('__moving_contact__', moving);
      const frameContacts = { ...segment.contacts, [segment.step.limb]: '__moving_contact__' };
      const motion = { movingLimb: segment.step.limb, supportFoot: segment.supportFoot, load, drive, airborne,
        grip: 1 - wave(t, segment.release - 0.07, segment.release + 0.12, segment.catch + 0.05),
        gazeTarget: segment.to, attention: wave(t, 0, segment.release, 1) };
      return IK.poseAt(torso, frameContacts, frameMap, { bendDirections: bends, motion, jointsOnly });
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
