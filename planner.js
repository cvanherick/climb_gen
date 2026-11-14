/* Bounded contact planner for the TB2 board. Returns failure explicitly; it
   never substitutes the candidate's precomputed hand plan. */
(function attach(root, factory) {
  const ik = root.ClimbGenIK || (typeof require === 'function' ? require('./ik') : null);
  const api = factory(ik);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ClimbGenPlanner = api;
})(typeof globalThis === 'object' ? globalThis : this, (IK) => {
  const LIMBS = ['leftHand', 'rightHand', 'leftFoot', 'rightFoot'];
  const labels = { leftHand: 'L hand', rightHand: 'R hand', leftFoot: 'L foot', rightFoot: 'R foot' };
  const idOf = (p) => String(p.id);
  function* search(problem, placements, options = {}) {
    const startedAt = Date.now();
    const maxExpanded = options.maxExpanded ?? 500;
    const beamWidth = options.beamWidth ?? 36;
    const maxDepth = options.maxDepth ?? 30;
    const weights = { reach: 0.28, stability: 0.12, effort: 1, awkwardness: 1 / 90, movement: 0.65, repeatLimb: 0.18, crossThrough: 0.28, highFoot: 0.16, ...(options.weights || {}) };
    const lookup = (id) => placements instanceof Map ? placements.get(String(id)) || placements.get(id) : placements[String(id)];
    const holds = problem.holds.map((h) => ({ ...h, position: lookup(h.id) })).filter((h) => h.position);
    const starts = holds.filter((h) => h.role === 5).sort((a, b) => a.position.x - b.position.x);
    const required = holds.filter((h) => h.role === 6 || h.role === 7).sort((a, b) => a.role - b.role || a.position.y - b.position.y || String(a.id).localeCompare(String(b.id)));
    const feet = holds.filter((h) => h.role === 8);
    if (starts.length < 1 || !required.some((h) => h.role === 7) || !required.some((h) => h.role === 6)) return { ok: false, reason: 'Route needs start, hand and finish holds.', expanded: 0 };
    const allIds = [...new Set([...starts, ...feet, ...holds.filter((h) => h.role === 6 || h.role === 7)].map(idOf))];
    const validFootIds = new Set(allIds);
    const left = starts[0], right = starts.at(-1);
    const startCenter = { x: (left.position.x + right.position.x) / 2, y: (left.position.y + right.position.y) / 2 - 18 };
    const nearbyFeet = [...feet, ...starts].sort((a, b) => Math.hypot(a.position.x - startCenter.x, a.position.y - (startCenter.y - 8)) - Math.hypot(b.position.x - startCenter.x, b.position.y - (startCenter.y - 8)));
    const leftFoot = nearbyFeet.find((h) => h.position.x <= startCenter.x) || nearbyFeet[0] || left;
    const rightFoot = nearbyFeet.find((h) => idOf(h) !== idOf(leftFoot) && h.position.x >= startCenter.x) || nearbyFeet.find((h) => idOf(h) !== idOf(leftFoot)) || right;
    const initial = { leftHand: idOf(left), rightHand: idOf(right), leftFoot: idOf(leftFoot), rightFoot: idOf(rightFoot) };
    if (initial.leftFoot === initial.rightFoot && allIds.length > 1) initial.rightFoot = idOf(feet.find((h) => idOf(h) !== initial.leftFoot) || right);
    const initialPose = IK.solve(initial, placements, null, { overhangDeg: options.overhangDeg ?? 40 });
    const reqIds = required.map(idOf);
    const reqIndex = new Map(reqIds.map((id, i) => [id, i]));
    const markVisited = (mask, id) => reqIndex.has(id) ? mask.add(id) : mask;
    const initialVisited = new Set([initial.leftHand, initial.rightHand]);
    const state = { contacts: initial, initialContacts: { ...initial }, visited: initialVisited, pose: initialPose, g: 0, path: [], depth: 0 };
    // Pose and last move stay in each search node and affect the objective. We
    // canonicalize equivalent contact/visited states to keep the beam bounded.
    const keyOf = (s) => `${LIMBS.map((l) => s.contacts[l]).join(',')}|${[...s.visited].sort().join(',')}`;
    const seen = new Map([[keyOf(state), 0]]);
    const heuristic = (s) => {
      const missing = required.filter((h) => !s.visited.has(idOf(h)));
      if (!missing.length) return 0;
      const hands = [lookup(s.contacts.leftHand), lookup(s.contacts.rightHand)];
      const minDistance = (h) => Math.min(...hands.map((p) => Math.hypot(p.x - h.position.x, p.y - h.position.y)));
      return missing.reduce((acc, h) => acc + Math.min(2.4, minDistance(h) / 40), 0) * 0.34;
    };
    const rank = (s) => s.g + heuristic(s);
    let beam = [state], expanded = 0, invalidTransitions = 0, bestPartial = state;
    for (let depth = 0; depth <= maxDepth && expanded < maxExpanded; depth++) {
      const goals = beam.filter((s) => required.filter((h) => h.role === 7).some((h) => s.visited.has(idOf(h))) && required.filter((h) => h.role === 6).every((h) => s.visited.has(idOf(h))));
      if (goals.length) {
        goals.sort((a, b) => a.g - b.g);
        return result(goals[0], initialPose, expanded, true, { invalidTransitions, elapsedMs: Date.now() - startedAt });
      }
      const nextBeam = [];
      for (const current of beam) {
        if (expanded++ >= maxExpanded) break;
        yield { expanded };
        const missing = required.filter((h) => !current.visited.has(idOf(h)));
        const targets = [...holds.filter((h) => h.role === 6 || h.role === 7), ...holds.filter((h) => validFootIds.has(idOf(h)))];
        for (let li = 0; li < LIMBS.length; li++) {
          const limb = LIMBS[li], isHand = li < 2;
          for (const target of targets) {
            const id = idOf(target);
            if (current.contacts[limb] === id) continue;
            if (isHand && target.role === 8) continue;
            if (!isHand && target.role === 7) continue;
            // Hands visit only route hand/finish holds. Feet may use designated
            // footholds and holds already touched by a hand.
            if (!isHand && target.role === 6 && !current.visited.has(id)) continue;
            const occupiedBy = LIMBS.filter((other) => other !== limb && current.contacts[other] === id);
            const canMatch = occupiedBy.length && (isHand
              ? occupiedBy.every((other) => other.endsWith('Hand'))
              : occupiedBy.every((other) => other.endsWith('Foot')));
            if (occupiedBy.length && !canMatch) continue;
            const contacts = { ...current.contacts, [limb]: id };
            const pose = IK.solve(contacts, placements, current.pose.torso, { overhangDeg: options.overhangDeg ?? 40, iterations: 4 });
            const diag = pose.diagnostics;
            if (!Number.isFinite(diag.estimatedCost)) continue;
            // Filter only grossly unreachable positions; softer elbow and
            // support penalties remain searchable and visible in diagnostics.
            if (diag.maxReachViolation > (options.maxReachViolation ?? 0.75) || diag.maxSegmentResidual > 0.25) { invalidTransitions++; continue; }
            const visited = new Set(current.visited);
            markVisited(visited, id);
            const targetPosition = target.position;
            const oldPosition = lookup(current.contacts[limb]);
            const movement = Math.hypot(targetPosition.x - oldPosition.x, targetPosition.y - oldPosition.y);
            const torsoMove = Math.hypot(pose.torso.x - current.pose.torso.x, pose.torso.y - current.pose.torso.y);
            const crossesBody = (limb.startsWith('left') && targetPosition.x > pose.torso.x + 8) || (limb.startsWith('right') && targetPosition.x < pose.torso.x - 8);
            const isHighFoot = !isHand && targetPosition.y > pose.torso.y + 12;
            const movementType = canMatch ? (isHand ? 'hand match' : 'foot swap')
              : isHighFoot ? 'high foot'
                : crossesBody ? 'cross-through' : !isHand ? 'foot reposition' : 'reach';
            const repeatsLimb = current.path.at(-1)?.limb === limb ? weights.repeatLimb : 0;
            // Prefer movement that keeps limbs on their own side and feet low
            // when alternatives reach the same route holds. These are soft
            // style costs: hard constraints still come from IK reach checks.
            const crossPenalty = crossesBody ? weights.crossThrough : 0;
            const highFootPenalty = isHighFoot
              ? weights.highFoot * Math.min(2, (targetPosition.y - pose.torso.y - 12) / 20)
              : 0;
            const movementQualityPenalty = crossPenalty + highFootPenalty;
            const next = {
              contacts, initialContacts: current.initialContacts, visited, pose, depth: depth + 1,
              g: current.g + weights.movement * (1 + movement / 52) + weights.effort * torsoMove / 90 + weights.reach * diag.maxReachViolation + weights.awkwardness * diag.maxAngleViolationDeg + weights.stability * diag.stabilityCost + repeatsLimb + movementQualityPenalty,
              path: [...current.path, { limb, label: labels[limb], movementType, movementQualityPenalty, id: target.id, role: target.role, contacts, pose, diagnostics: diag }],
            };
            const key = keyOf(next), previousCost = seen.get(key);
            if (previousCost != null && previousCost <= next.g) continue;
            seen.set(key, next.g);
            nextBeam.push(next);
            if (next.visited.size > bestPartial.visited.size || (next.visited.size === bestPartial.visited.size && next.g < bestPartial.g)) bestPartial = next;
          }
        }
      }
      nextBeam.sort((a, b) => rank(a) - rank(b) || a.depth - b.depth);
      beam = nextBeam.slice(0, beamWidth);
      if (!beam.length) break;
    }
    return { ok: false, reason: `No contact sequence found within ${expanded} evaluated states.`, expanded, invalidTransitions, elapsedMs: Date.now() - startedAt, partial: { visited: bestPartial.visited.size, required: required.length } };
  }
  function result(state, initialPose, expanded, ok, searchStats) {
    return { ok, steps: state.path, initialContacts: state.initialContacts, initialPose, finalContacts: state.contacts, finalPose: state.pose, expanded, ...searchStats, cost: state.g,
      diagnostics: { maxReachViolation: Math.max(0, ...state.path.map((s) => s.diagnostics.maxReachViolation)), maxAngleViolationDeg: Math.max(0, ...state.path.map((s) => s.diagnostics.maxAngleViolationDeg)), maxSegmentResidual: Math.max(0, ...state.path.map((s) => s.diagnostics.maxSegmentResidual || 0)), maxEstimatedStabilityCost: Math.max(0, ...state.path.map((s) => s.diagnostics.stabilityCost)) } };
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
