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
  function create(plan, placements) {
    if (!plan?.ok || !plan.initialPose || !plan.initialContacts) throw new Error('A contact plan is required for playback.');
    const segments = [];
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
      // Straight contact interpolation can pass through a hip or shoulder,
      // folding the limb nearly to zero and spinning the joint. Search gentle
      // side arcs once, penalizing joint-limit violations and abrupt rotation.
      let bestCost = Infinity;
      const side = step.limb.startsWith('left') ? -1 : 1;
      for (const amplitude of [0, 6, 12, 18, 24, -6, -12, -18, -24]) {
        segment.arc = side * amplitude;
        let cost = 0, prior = null;
        for (let i = 0; i <= 24; i++) {
          const pose = framePose(segment, i / 24);
          cost += pose.diagnostics.maxAngleViolationDeg ** 2 * 0.04 + pose.diagnostics.maxSegmentResidual ** 2 * 100;
          const key = step.limb.replace('Hand', 'Elbow').replace('Foot', 'Knee');
          if (prior) cost += Math.hypot(pose.points[key].x - prior.x, pose.points[key].y - prior.y) ** 2;
          prior = pose.points[key];
        }
        cost += Math.abs(amplitude) * 0.12 + (amplitude < 0 ? 1 : 0);
        if (cost < bestCost) { bestCost = cost; segment.bestArc = segment.arc; }
      }
      segment.arc = segment.bestArc;
      let priorPose = framePose(segment, 0), peakStep = 0;
      for (let i = 1; i <= 64; i++) {
        const nextPose = framePose(segment, i / 64);
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
    function framePose(segment, t) {
      // Prepare the body, reach with one limb, then settle on the new contact.
      const bodyT = ease(t), reachT = ease((t - 0.18) / 0.64);
      const torso = {};
      for (const key of ['x', 'y', 'theta', 'hipTheta']) torso[key] = mix(segment.startTorso[key] || 0, segment.endTorso[key] || 0, bodyT);
      const moving = { x: mix(segment.from.x, segment.to.x, reachT) + segment.arc * Math.sin(Math.PI * reachT) ** 2, y: mix(segment.from.y, segment.to.y, reachT) };
      // Preserve real contact metadata during the planted portions; an airborne
      // hand has no hold-direction label or support contact.
      if (reachT === 0) moving.profile = segment.from.profile;
      if (reachT === 1) moving.profile = segment.to.profile;
      const frameMap = new Map(placements instanceof Map ? placements : Object.entries(placements));
      frameMap.set('__moving_contact__', moving);
      const frameContacts = { ...segment.contacts, [segment.step.limb]: '__moving_contact__' };
      return IK.poseAt(torso, frameContacts, frameMap, { bendDirections: bends });
    }
    function sample(elapsed = 0) {
      const time = Math.max(0, Math.min(total, elapsed));
      const segment = segments.find(s => time < s.start + s.duration) || segments.at(-1);
      if (!segment) return { pose: plan.initialPose, stepIndex: 0, done: true, phase: 'settle' };
      const t = clamp((time - segment.start) / segment.duration);
      const pose = framePose(segment, t);
      return { pose, stepIndex: segment.index, done: time >= total, phase: t < 0.18 ? 'prepare' : t < 0.82 ? 'reach' : 'settle', elapsed: time };
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
