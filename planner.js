/* Bounded contact planner for the TB2 board. Returns failure explicitly; it
   never substitutes the candidate's precomputed hand plan. */
(function attach(root, factory) {
  const ik = root.ClimbGenIK || (typeof require === 'function' ? require('./ik') : null);
  const api = factory(ik);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ClimbGenPlanner = api;
})(typeof globalThis === 'object' ? globalThis : this, (IK) => {
  const LIMBS = ['leftHand', 'rightHand', 'leftFoot', 'rightFoot'];
  const oppositeLimb = { leftHand: 'rightHand', rightHand: 'leftHand', leftFoot: 'rightFoot', rightFoot: 'leftFoot' };
  const labels = { leftHand: 'L hand', rightHand: 'R hand', leftFoot: 'L foot', rightFoot: 'R foot' };
  const idOf = (p) => String(p.id);
  function* search(problem, placements, options = {}) {
    const startedAt = Date.now();
    const maxExpanded = options.maxExpanded ?? 500;
    const beamWidth = options.beamWidth ?? 36;
    const maxDepth = options.maxDepth ?? 30;
    const style = options.style === 'static' || options.style === 'dynamic' ? options.style : 'any';
    const weights = {
      reach: 0.28, stability: 0.12, effort: 1, awkwardness: 1 / 90,
      movement: style === 'dynamic' ? 0.36 : style === 'static' ? 0.82 : 0.65,
      repeatLimb: style === 'dynamic' ? 0.1 : 0.18,
      crossThrough: style === 'dynamic' ? 0.08 : style === 'static' ? 0.48 : 0.28,
      highFoot: style === 'dynamic' ? 0.06 : style === 'static' ? 0.28 : 0.16,
      ...(options.weights || {}),
    };
    const lookup = (id) => placements instanceof Map ? placements.get(String(id)) || placements.get(id) : placements[String(id)];
    const holds = problem.holds.map((h) => ({ ...h, position: lookup(h.id) })).filter((h) => h.position);
    const starts = holds.filter((h) => h.role === 5).sort((a, b) => a.position.x - b.position.x);
    const required = holds.filter((h) => h.role === 6 || h.role === 7).sort((a, b) => a.role - b.role || a.position.y - b.position.y || String(a.id).localeCompare(String(b.id)));
    const feet = holds.filter((h) => h.role === 8);
    if (starts.length < 1 || !required.some((h) => h.role === 7) || !required.some((h) => h.role === 6)) return { ok: false, reason: 'Route needs start, hand and finish holds.', expanded: 0 };
    const handholds = [...starts, ...required];
    const footTargets = holds.filter(h => h.role !== 7);
    const middleIds = required.filter(h => h.role === 6).map(idOf);
    const finishes = required.filter(h => h.role === 7);
    const finishIds = new Set(finishes.map(idOf));
    const finishY = Math.min(...finishes.map(h => h.position.y));
    const left = starts[0], right = starts.at(-1);
    const startX = (left.position.x + right.position.x) / 2;
    const startY = Math.min(left.position.y, right.position.y);
    const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const overhangDeg = options.overhangDeg ?? 40;
    const maxReachViolation = options.maxReachViolation ?? 0.75;
    const feasible = pose => Number.isFinite(pose.diagnostics.estimatedCost)
      && pose.diagnostics.maxReachViolation <= maxReachViolation && pose.diagnostics.maxSegmentResidual <= 0.25
      && pose.diagnostics.maxFootHeightViolation < .05;
    // Rank actual toe placements around a low, uncrossed sit start. Both hands
    // already occupy the start hold(s), so those are unavailable to the feet.
    const stances = [];
    for (const lf of feet) for (const rf of feet) {
      const score = distance(lf.position, { x: startX - 10, y: startY - 30 })
        + distance(rf.position, { x: startX + 10, y: startY - 30 })
        + Math.max(0, lf.position.x - rf.position.x);
      stances.push({ score, leftFoot: idOf(lf), rightFoot: idOf(rf), matched: idOf(lf) === idOf(rf) });
    }
    // A board can have one reachable foothold at the start and another high
    // foothold intended for later. Try a toe match after all split stances.
    stances.sort((a, b) => Number(a.matched) - Number(b.matched) || a.score - b.score);
    let initial, initialPose;
    for (const stance of stances) {
      const contacts = { leftHand: idOf(left), rightHand: idOf(right), leftFoot: stance.leftFoot, rightFoot: stance.rightFoot };
      const pose = IK.solve(contacts, placements, null, { overhangDeg });
      if (feasible(pose)) { initial = contacts; initialPose = pose; break; }
    }
    if (!initialPose) return { ok: false, reason: 'No contact sequence with a reachable starting stance on the selected feet.', expanded: 0 };
    const initialVisited = new Set();
    const state = { contacts: initial, initialContacts: { ...initial }, visited: initialVisited, pose: initialPose, g: 0, path: [], depth: 0 };
    // Pose and last move stay in each search node and affect the objective. We
    // canonicalize equivalent contact/visited states to keep the beam bounded.
    const keyOf = (s) => `${LIMBS.map((l) => s.contacts[l]).join(',')}|${[...s.visited].sort().join(',')}`;
    const seen = new Map([[keyOf(state), 0]]);
    const atFinish = s => finishIds.has(s.contacts.leftHand) && finishIds.has(s.contacts.rightHand)
      && (finishIds.size === 1 || s.contacts.leftHand !== s.contacts.rightHand);
    const nextTargets = s => {
      const middle = required.filter(h => h.role === 6 && !s.visited.has(idOf(h)));
      return middle.length ? middle : finishes;
    };
    const heuristic = s => {
      const hands = [lookup(s.contacts.leftHand), lookup(s.contacts.rightHand)];
      const targets = nextTargets(s);
      const nearest = Math.min(...targets.map(h => Math.min(...hands.map(p => distance(p, h.position)))));
      const feetY = (lookup(s.contacts.leftFoot).y + lookup(s.contacts.rightFoot).y) / 2;
      const missingHands = middleIds.filter(id => !s.visited.has(id)).length
        + Number(!finishIds.has(s.contacts.leftHand)) + Number(!finishIds.has(s.contacts.rightHand));
      // Estimate both hand placements and the footwork needed to bring the hips
      // within reaching distance of the finish. This gives a useful step-up a
      // place in the beam even though it does not tick off another handhold.
      return weights.movement * (1.65 * missingHands + Math.max(0, finishY - 60 - feetY) / 18 + nearest / 55);
    };
    const rank = s => s.g + s.remaining;
    const body = IK.DEFAULT_BODY;
    // Triangle-inequality bounds skip IK only when two contacts cannot be
    // spanned even by fully extended limbs at any torso orientation.
    const arm = body.upperArm + body.lowerArm + body.palmLength;
    const leg = body.upperLeg + body.lowerLeg + body.footLength + 1.5;
    const maxSpan = [
      arm * 2 + body.shoulderWidth + 1,
      arm + leg + Math.hypot(body.torsoLength, body.shoulderWidth / 2) + body.hipWidth / 2 + 1,
      leg * 2 + body.hipWidth + 1,
    ];
    const contactPoses = new Map();
    state.remaining = heuristic(state);
    let beam = [state], expanded = 0, invalidTransitions = 0, bestPartial = state;
    for (let depth = 0; depth <= maxDepth; depth++) {
      const goals = beam.filter(atFinish);
      if (goals.length) {
        goals.sort((a, b) => a.g - b.g);
        const alternatives = [], signatures = new Set();
        for (const goal of goals) {
          const signature = goal.path.map((step) => `${step.limb}:${step.id}`).join('|');
          if (signatures.has(signature)) continue;
          signatures.add(signature);
          alternatives.push(result(goal, initialPose, expanded, true, { invalidTransitions, elapsedMs: Date.now() - startedAt }));
          if (alternatives.length >= Math.max(1, options.numAlternatives ?? 3)) break;
        }
        return { ...alternatives[0], alternatives };
      }
      if (depth === maxDepth || expanded >= maxExpanded) break;
      const nextBeam = new Map();
      for (const current of beam) {
        if (expanded >= maxExpanded) break;
        expanded++;
        yield { expanded };
        const middleComplete = middleIds.every(id => current.visited.has(id));
        for (let li = 0; li < LIMBS.length; li++) {
          const limb = LIMBS[li], isHand = li < 2;
          const otherLimbs = LIMBS.filter(other => other !== limb);
          const support = otherLimbs.map(other => lookup(current.contacts[other]));
          const supportHull = IK.convexHull(support);
          for (const target of (isHand ? handholds : footTargets)) {
            const id = idOf(target);
            if (current.contacts[limb] === id) continue;
            if (target.role === 7 && !middleComplete) continue;
            // Feet can step onto a vacated start, a designated foothold, or a
            // middle hold the hands have established.
            if (!isHand && target.role === 6 && !current.visited.has(id)) continue;
            const occupiedBy = LIMBS.filter((other) => other !== limb && current.contacts[other] === id);
            const canMatch = occupiedBy.length && (isHand
              ? occupiedBy.every((other) => other.endsWith('Hand'))
              : occupiedBy.every((other) => other.endsWith('Foot')));
            if (occupiedBy.length && !canMatch) continue;
            const contacts = { ...current.contacts, [limb]: id };
            if (otherLimbs.some((other, i) => distance(target.position, support[i]) >
              maxSpan[Number(!isHand) + Number(other.endsWith('Foot'))])) { invalidTransitions++; continue; }
            // A contact configuration recurs along many paths. Reuse a feasible
            // pose only for nearby incoming hips with the same bend branches.
            const poseKey = LIMBS.map(l => contacts[l]).join(',');
            let pose = contactPoses.get(poseKey);
            if (!pose || distance(pose.torso, current.pose.torso) > 20
              || LIMBS.some(l => pose.bendDirections[l] !== current.pose.bendDirections[l])) {
              pose = IK.solve(contacts, placements, current.pose.torso, { overhangDeg, iterations: 4, previousPose: current.pose });
              if (feasible(pose)) contactPoses.set(poseKey, pose);
            }
            const diag = pose.diagnostics;

            // Filter only grossly unreachable positions; softer elbow and
            // support penalties remain searchable and visible in diagnostics.
            if (!feasible(pose)) { invalidTransitions++; continue; }
            const visited = new Set(current.visited);
            if (isHand && target.role !== 5) visited.add(id);
            const targetPosition = target.position;
            const oldPosition = lookup(current.contacts[limb]);
            const movement = Math.hypot(targetPosition.x - oldPosition.x, targetPosition.y - oldPosition.y);
            const torsoMove = Math.hypot(pose.torso.x - current.pose.torso.x, pose.torso.y - current.pose.torso.y);
            const crossesBody = (limb.startsWith('left') && targetPosition.x > pose.torso.x + 8) || (limb.startsWith('right') && targetPosition.x < pose.torso.x - 8);
            const oldCom = current.pose.diagnostics.centerOfMass;
            const releaseCom = { x: (oldCom.x + diag.centerOfMass.x) / 2, y: (oldCom.y + diag.centerOfMass.y) / 2 };
            const releaseDistance = IK.outsideHullDistance(releaseCom, supportHull);
            const supportPenalty = (style === 'dynamic' ? 0.28 : 0.60) * Math.min(3, (releaseDistance / 16) ** 2);
            const feetSpan = distance(lookup(contacts.leftFoot), lookup(contacts.rightFoot));
            const stancePenalty = 0.4 * Math.max(0, 1 - feetSpan / 12);
            const isHighFoot = !isHand && targetPosition.y > pose.torso.y - 4 && targetPosition.y > oldPosition.y + 8;
            const opposite = lookup(contacts[oppositeLimb[limb]]);
            const side = limb.startsWith('left') ? -1 : 1;
            const crossesContact = side * (oldPosition.x - opposite.x) >= -2 && side * (targetPosition.x - opposite.x) < -4;
            let movementType;
            if (canMatch) movementType = isHand ? 'hand match' : 'foot match';
            else if (crossesContact) movementType = isHand ? 'cross-through' : 'step through';
            else if (!isHand) movementType = isHighFoot ? 'high foot' : 'foot reposition';
            else if (current.path.at(-1)?.limb === limb) movementType = 'hand bump';
            else if (pose.torso.y > current.pose.torso.y + 5 && current.path.at(-1)?.limb.endsWith('Foot')) movementType = 'stand and reach';
            else movementType = movement > arm ? 'long reach' : 'reach';
            const repeatsLimb = current.path.at(-1)?.limb === limb ? weights.repeatLimb : 0;
            // Prefer movement that keeps limbs on their own side and feet low
            // when alternatives reach the same route holds. These are soft
            // style costs: hard constraints still come from IK reach checks.
            const crossPenalty = crossesBody ? weights.crossThrough : 0;
            const highFootPenalty = isHighFoot
              ? weights.highFoot * Math.min(2, (targetPosition.y - pose.torso.y + 4) / 20)
              : 0;
            const lungeBias = isHand && movement > 18
              ? (style === 'dynamic' ? -0.24 : style === 'static' ? 0.18 : 0) * Math.min(1, (movement - 18) / 18)
              : 0;
            const movementQualityPenalty = crossPenalty + highFootPenalty + lungeBias + supportPenalty + stancePenalty;
            const next = {
              contacts, initialContacts: current.initialContacts, visited, pose, depth: depth + 1,
              g: current.g + weights.movement * (1 + movement / 52) + weights.effort * torsoMove / 90 + weights.reach * diag.maxReachViolation + weights.awkwardness * diag.maxAngleViolationDeg + .055 * diag.articulationCost + weights.stability * diag.stabilityCost + (diag.holdDirectionCost || 0) * 0.6 + (diag.footDifficultyCost || 0) * 0.15 + (diag.handDifficultyCost || 0) * 0.1 + repeatsLimb + movementQualityPenalty,
              path: [...current.path, { limb, label: labels[limb], movementType, movementDistance: movement, releaseSupportDistance: releaseDistance, movementQualityPenalty, id: target.id, role: target.role, contacts, pose, diagnostics: diag }],
            };
            const key = keyOf(next), previousCost = seen.get(key);
            if (previousCost != null && previousCost <= next.g) continue;
            seen.set(key, next.g);
            next.remaining = heuristic(next);
            nextBeam.set(key, next);
            if (next.visited.size > bestPartial.visited.size || (next.visited.size === bestPartial.visited.size && next.g < bestPartial.g)) bestPartial = next;
          }
        }
      }
      beam = [...nextBeam.values()].sort((a, b) => Number(atFinish(b)) - Number(atFinish(a)) || rank(a) - rank(b)).slice(0, beamWidth);
      if (!beam.length) break;
    }
    return { ok: false, reason: `No contact sequence found within ${expanded} evaluated states.`, expanded, invalidTransitions, elapsedMs: Date.now() - startedAt, partial: { visited: bestPartial.visited.size, required: required.length } };
  }
  function result(state, initialPose, expanded, ok, searchStats) {
    return { ok, steps: state.path, initialContacts: state.initialContacts, initialPose, finalContacts: state.contacts, finalPose: state.pose, expanded, ...searchStats, cost: state.g,
      diagnostics: { maxReachViolation: Math.max(0, ...state.path.map((s) => s.diagnostics.maxReachViolation)), maxAngleViolationDeg: Math.max(0, ...state.path.map((s) => s.diagnostics.maxAngleViolationDeg)), maxSegmentResidual: Math.max(0, ...state.path.map((s) => s.diagnostics.maxSegmentResidual || 0)), maxHoldDirectionCost: Math.max(0, ...state.path.map((s) => s.diagnostics.holdDirectionCost || 0)), maxEstimatedStabilityCost: Math.max(0, ...state.path.map((s) => s.diagnostics.stabilityCost)) } };
  }
  function plan(problem, placements, options = {}) {
    const iterator = search(problem, placements, options);
    while (true) { const step = iterator.next(); if (step.done) return step.value; }
  }
  function planAsync(problem, placements, options = {}) {
    const iterator = search(problem, placements, options);
    return new Promise((resolve) => {
      const pump = () => {
        try {
          if (options.signal?.aborted) {
            iterator.return();
            resolve({ ok: false, reason: 'Planning cancelled.', expanded: 0 });
            return;
          }
          // One full beam-expansion pass can be costly, so yield to the browser
          // after each expanded state to keep paint and buttons responsive.
          const step = iterator.next();
          if (step.done) resolve(step.value);
          else { options.onProgress?.(step.value.expanded); setTimeout(pump, 0); }
        } catch (error) { resolve({ ok: false, reason: error?.message || 'Planner failed.', expanded: 0 }); }
      };
      setTimeout(pump, 0);
    });
  }
  return { plan, planAsync, LIMBS };
});
