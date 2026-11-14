(() => {
  const svg = document.getElementById('board-svg');
  const $ = (id) => document.getElementById(id);
  const roleName = { 5: 'start', 6: 'hand', 7: 'finish', 8: 'foot' };
  const boardAssets = window.CLIMBGEN_ASSETS || {
    wood: './assets/tb2-12x12-mirror-wood.png',
    plastic: './assets/tb2-12x12-mirror-plastic.png',
  };
  const board = { left: -68, right: 68, bottom: 0, top: 144, x: 20, y: 13.26, width: 560, height: 593.48 };
  const holdMap = new Map();
  let dataset, generatedCount = 0, animationTimer, betaTimer, generating = false, currentProblem = null;
  const usedCandidates = new Map();

  function point(x, y) {
    return {
      x: board.x + (x - board.left) / (board.right - board.left) * board.width,
      y: board.y + board.height - (y - board.bottom) / (board.top - board.bottom) * board.height,
    };
  }
  function svgEl(name, attrs = {}) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', name);
    for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
    return el;
  }
  function drawBoard(route = null, activeStep = -1, figure = null) {
    svg.replaceChildren();
    svg.append(
      svgEl('image', { x: board.x, y: board.y, width: board.width, height: board.height, href: boardAssets.plastic, preserveAspectRatio: 'none' }),
      svgEl('image', { x: board.x, y: board.y, width: board.width, height: board.height, href: boardAssets.wood, preserveAspectRatio: 'none' }),
    );
    if (route) {
      route.holds.forEach((hold) => {
        const position = holdMap.get(String(hold.id));
        const p = point(position.x, position.y);
        const role = roleName[hold.role];
        const ring = svgEl('circle', { cx: p.x, cy: p.y, r: 11, class: `route-ring ${role}` });
        const title = svgEl('title');
        title.textContent = `${role} · ${position.label} · placement ${hold.id}`;
        ring.append(title);
        svg.append(ring);
      });
      if (activeStep >= 0 && route.plan[activeStep]) {
        const hold = holdMap.get(String(route.plan[activeStep].id));
        const p = point(hold.x, hold.y);
        svg.append(svgEl('circle', { cx: p.x, cy: p.y, r: 16, class: 'active-ring' }));
      }
    }
    if (figure) drawClimber(figure);
  }
  function drawClimber(frame) {
    const line = (a, b, className = 'climber-limb') => {
      const aa = point(a.x, a.y), bb = point(b.x, b.y);
      svg.append(svgEl('line', { x1: aa.x, y1: aa.y, x2: bb.x, y2: bb.y, class: className }));
    };
    const dot = (p, r, className = 'climber-joint') => {
      const pp = point(p.x, p.y);
      svg.append(svgEl('circle', { cx: pp.x, cy: pp.y, r, class: className }));
    };
    const p = frame.points;
    line(p.neck, p.pelvis, 'climber-body');
    for (const side of ['left', 'right']) {
      line(p[`${side}Shoulder`], p[`${side}Elbow`]);
      line(p[`${side}Elbow`], p[`${side}Hand`]);
      line(p[`${side}Hip`], p[`${side}Knee`]);
      line(p[`${side}Knee`], p[`${side}Foot`]);
      dot(p[`${side}Elbow`], 3);
      dot(p[`${side}Knee`], 3);
    }
    dot(p.pelvis, 4);
    dot(p.head, 4.5, 'climber-head');
  }
  function keyFor(holds) {
    return holds.map((h) => `${h[0]}r${h[1]}`).sort().join('|');
  }
  function distance(a, b) {
    const ah = holdMap.get(String(a)), bh = holdMap.get(String(b));
    return Math.hypot(ah.x - bh.x, ah.y - bh.y);
  }
  function planner(holds) {
    const starts = holds.filter((h) => h.role === 5).map((h) => h.id).sort((a, b) => holdMap.get(String(a)).x - holdMap.get(String(b)).x);
    const middle = holds.filter((h) => h.role === 6).map((h) => h.id);
    const finishes = holds.filter((h) => h.role === 7).map((h) => h.id);
    if (!starts.length || !middle.length || !finishes.length) return null;
    const leftStart = starts[0], rightStart = starts.length > 1 ? starts[starts.length - 1] : starts[0];
    const reachLimit = 43;
    let best = null;
    const visit = (left, right, remaining, path, cost, previousLimb) => {
      if (!remaining.length) {
        for (const finish of finishes) {
          const options = [
            { limb: 'L hand', d: distance(left, finish), side: 'left' },
            { limb: 'R hand', d: distance(right, finish), side: 'right' },
          ].filter((v) => v.d <= reachLimit).sort((a, b) => a.d - b.d);
          for (const option of options) {
            const total = cost + option.d + (option.side === previousLimb ? 5 : 0);
            if (!best || total < best.cost) best = { cost: total, path: [...path, { id: finish, limb: option.limb, role: 7 }] };
          }
        }
        return;
      }
      if (best && cost >= best.cost) return;
      for (const id of remaining) {
        const options = [
          { limb: 'L hand', d: distance(left, id), side: 'left' },
          { limb: 'R hand', d: distance(right, id), side: 'right' },
        ].filter((v) => v.d <= reachLimit).sort((a, b) => a.d - b.d);
        for (const option of options) {
          const next = remaining.filter((x) => x !== id);
          visit(option.side === 'left' ? id : left, option.side === 'right' ? id : right, next,
            [...path, { id, limb: option.limb, role: 6 }], cost + option.d + (option.side === previousLimb ? 5 : 0), option.side);
        }
      }
    };
    visit(leftStart, rightStart, middle, [], 0, null);
    return best?.path || null;
  }
  function routeHolds(record) {
    return record.holds.map(([id, role]) => ({ id, role }));
  }
  function hashName(value) {
    let hash = 2166136261;
    for (const char of value.normalize('NFKC').trim().toLowerCase()) {
      hash ^= char.codePointAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }
  function sampleProblem() {
    // Candidate generation and reach checking happen at build time. Keeping the
    // click path to a single array lookup avoids a long-running planner freezing
    // the page or leaving the Generate button stuck in its busy state.
    const targetGrade = $('grade-select').value;
    const pool = targetGrade === 'any'
      ? dataset.generated
      : dataset.generated.filter((candidate) => candidate.source.grade === targetGrade);
    if (!Array.isArray(pool) || pool.length === 0) throw new Error('No prepared TB2 problems are bundled');
    const typedName = $('climb-name').value.trim();
    const climbName = typedName || `Climb ${String(generatedCount + 1).padStart(2, '0')}`;
    const seed = hashName(`${climbName}|${targetGrade}|${generatedCount}`);
    const seen = usedCandidates.get(targetGrade) || new Set();
    let candidate = null;
    for (let offset = 0; offset < pool.length; offset++) {
      const option = pool[(seed + offset) % pool.length];
      const signature = keyFor(option.holds);
      if (!seen.has(signature)) { candidate = option; seen.add(signature); break; }
    }
    if (!candidate) {
      seen.clear();
      candidate = pool[seed % pool.length];
      seen.add(keyFor(candidate.holds));
    }
    usedCandidates.set(targetGrade, seen);
    if (!Array.isArray(candidate.holds) || !Array.isArray(candidate.plan)) throw new Error('Prepared TB2 problem is invalid');
    return {
      holds: routeHolds(candidate),
      plan: candidate.plan,
      source: candidate.source,
      changed: candidate.changed,
      name: climbName,
    };
  }
  function renderResult(problem) {
    clearInterval(betaTimer);
    currentProblem = problem;
    generatedCount++;
    $('route-title').textContent = problem.name;
    $('route-grade').textContent = `40° · ≈${problem.source.grade}`;
    $('route-copy').textContent = `${problem.holds.length} holds · ${problem.plan.length} moves · ${problem.source.grade}`;
    $('hold-count').textContent = problem.holds.length;
    $('move-count').textContent = problem.plan.length;
    $('data-count').textContent = dataset.filtered_routes.toLocaleString();
    $('beta-status').textContent = 'BETA HIDDEN';
    $('beta-button').hidden = false;
    $('beta-button').disabled = false;
    $('beta-button').textContent = 'Reveal beta animation';
    $('board-status').textContent = problem.changed ? 'GENERATED' : 'COMMUNITY ROUTE';
    $('board-status').classList.add('ready');
    $('board-hint').classList.add('hidden');
    const list = $('sequence-list');
    list.replaceChildren(sequenceItem(null, null, 'Hidden until revealed', 'empty'));
    drawBoard(problem, -1);
  }
  function sequenceItem(number, id, label, role) {
    const li = document.createElement('li');
    if (id == null) {
      li.className = 'sequence-empty';
      li.textContent = label;
      return li;
    }
    const hold = holdMap.get(String(id));
    li.dataset.holdId = id;
    li.innerHTML = `<span class="step-number">${number == null ? '·' : String(number).padStart(2, '0')}</span><i class="step-dot ${role}"></i><span class="step-hold">${hold.label} <small>#${id}</small></span><span class="step-limb">${label}</span>`;
    return li;
  }
  function animatePlan(problem) {
    clearInterval(animationTimer);
    let current = 0;
    const tick = () => {
      const items = [...$('sequence-list').querySelectorAll('li[data-hold-id]')];
      items.forEach((item) => item.classList.remove('active'));
      if (current >= problem.plan.length) { drawBoard(problem); clearInterval(animationTimer); return; }
      const item = [...$('sequence-list').querySelectorAll('li[data-hold-id]')].find((li) => Number(li.dataset.holdId) === problem.plan[current].id);
      if (item) item.classList.add('active');
      drawBoard(problem, current);
      current++;
    };
    tick();
    animationTimer = setInterval(tick, 650);
  }
  const limbInfo = {
    leftHand: { root: [-7, 20], upper: 22, lower: 22, side: -1 },
    rightHand: { root: [7, 20], upper: 22, lower: 22, side: 1 },
    leftFoot: { root: [-6, 0], upper: 24, lower: 23, side: -1 },
    rightFoot: { root: [6, 0], upper: 24, lower: 23, side: 1 },
  };
  const limbFor = (label) => label.startsWith('L') ? (label.includes('foot') ? 'leftFoot' : 'leftHand') : (label.includes('foot') ? 'rightFoot' : 'rightHand');
  const posOf = (id) => {
    const p = holdMap.get(String(id));
    return { x: p.x, y: p.y, id };
  };
  function contactSequence(problem) {
    const starts = problem.holds.filter((h) => h.role === 5).map((h) => posOf(h.id)).sort((a, b) => a.x - b.x);
    const feet = problem.holds.filter((h) => h.role === 8).map((h) => posOf(h.id));
    const leftStart = starts[0], rightStart = starts[starts.length - 1];
    const centerX = (leftStart.x + rightStart.x) / 2;
    const centerY = (leftStart.y + rightStart.y) / 2 - 18;
    const orderedFeet = [...feet].sort((a, b) => Math.abs(a.y - (centerY - 4)) - Math.abs(b.y - (centerY - 4)));
    const leftFoot = orderedFeet.find((p) => p.x <= centerX) || orderedFeet[0] || leftStart;
    const rightFoot = orderedFeet.find((p) => p.x >= centerX && p.id !== leftFoot.id) || orderedFeet.find((p) => p.id !== leftFoot.id) || rightFootFallback();
    function rightFootFallback() { return orderedFeet[0] || rightStart; }
    const initialIds = [leftStart.id, rightStart.id, leftFoot.id, rightFoot.id];
    const initialContacts = Object.fromEntries(Object.keys(limbInfo).map((limb, i) => [limb, posOf(initialIds[i])]));
    const initialPose = makePose(initialContacts, { x: centerX, y: centerY });
    const handTargets = problem.plan.map((step) => ({ id: step.id, role: step.role }));
    const eligibleFeet = [...new Set([...problem.holds.filter((h) => h.role === 8).map((h) => h.id), ...starts.map((p) => p.id)])];
    const queue = [{ progress: 0, ids: initialIds, path: [], torso: initialPose.torso }];
    const visited = new Set();
    const stateKey = (state) => `${state.progress}:${state.ids.join(',')}`;
    const limbNames = Object.keys(limbInfo);
    const contactsFrom = (ids) => Object.fromEntries(limbNames.map((limb, i) => [limb, posOf(ids[i])]));
    let head = 0;
    while (head < queue.length && head < 12000) {
      const state = queue[head++];
      const key = stateKey(state);
      if (visited.has(key)) continue;
      visited.add(key);
      if (state.progress === handTargets.length) {
        return { contacts: contactsFrom(initialIds), steps: state.path, torso: initialPose.torso };
      }
      const actions = [];
      const target = handTargets[state.progress];
      for (const limbIndex of [0, 1]) actions.push({ limbIndex, id: target.id, role: target.role, advance: 1 });
      const reached = handTargets.slice(0, state.progress).map((step) => step.id);
      for (const id of reached) {
        for (const limbIndex of [0, 1]) {
          if (holdMap.get(String(id)).y > holdMap.get(String(state.ids[limbIndex])).y + 4) actions.push({ limbIndex, id, role: 6, advance: 0 });
        }
      }
      const footTargets = [...new Set([...eligibleFeet, ...reached])];
      for (const limbIndex of [2, 3]) {
        for (const id of footTargets) {
          if (holdMap.get(String(id)).y > holdMap.get(String(state.ids[limbIndex])).y + 5) actions.push({ limbIndex, id, role: 8, advance: 0 });
        }
      }
      for (const action of actions) {
        if (state.ids[action.limbIndex] === action.id) continue;
        const occupied = state.ids.filter((_, i) => i !== action.limbIndex).includes(action.id);
        const handToHandShare = action.limbIndex < 2 && state.ids.slice(0, 2).includes(action.id);
        if (occupied && !handToHandShare) continue;
        const ids = [...state.ids];
        ids[action.limbIndex] = action.id;
        const contacts = contactsFrom(ids);
        const pose = makePose(contacts, state.torso);
        if (pose.maxViolation > 5) continue;
        const next = {
          progress: state.progress + action.advance,
          ids,
          path: [...state.path, { limb: limbNames[action.limbIndex], id: action.id, role: action.role }],
          torso: pose.torso,
        };
        if (!visited.has(stateKey(next))) queue.push(next);
      }
    }
    return { contacts: initialContacts, steps: problem.plan.map((step) => ({ limb: limbFor(step.limb), id: step.id, role: step.role })), torso: initialPose.torso };
  }
  function solveTorso(contacts, previous) {
    let torso = { ...previous };
    let maxViolation = 0;
    for (let iteration = 0; iteration < 90; iteration++) {
      let gx = 0, gy = 0;
      maxViolation = 0;
      for (const [limb, endpoint] of Object.entries(contacts)) {
        const info = limbInfo[limb];
        const root = { x: torso.x + info.root[0], y: torso.y + info.root[1] };
        const dx = root.x - endpoint.x, dy = root.y - endpoint.y;
        const d = Math.max(0.001, Math.hypot(dx, dy));
        const min = Math.abs(info.upper - info.lower) + 1;
        const max = info.upper + info.lower - 1;
        const error = d < min ? d - min : d > max ? d - max : 0;
        maxViolation = Math.max(maxViolation, Math.abs(error));
        if (error) { gx += 8 * error * dx / d; gy += 8 * error * dy / d; }
      }
      gx += 0.12 * (torso.x - previous.x);
      gy += 0.12 * (torso.y - previous.y);
      torso.x -= Math.max(-3, Math.min(3, gx * 0.035));
      torso.y -= Math.max(-3, Math.min(3, gy * 0.035));
      torso.x = Math.max(-60, Math.min(60, torso.x));
      torso.y = Math.max(3, Math.min(136, torso.y));
    }
    for (const [limb, endpoint] of Object.entries(contacts)) {
      const info = limbInfo[limb], root = { x: torso.x + info.root[0], y: torso.y + info.root[1] };
      const d = Math.hypot(root.x - endpoint.x, root.y - endpoint.y);
      maxViolation = Math.max(maxViolation, Math.max(0, d - info.upper - info.lower + 1, Math.abs(info.upper - info.lower) + 1 - d));
    }
    return { torso, maxViolation };
  }
  function twoBone(root, target, upper, lower, side) {
    const dx = target.x - root.x, dy = target.y - root.y;
    const raw = Math.max(0.01, Math.hypot(dx, dy));
    const d = Math.min(upper + lower - 0.05, Math.max(Math.abs(upper - lower) + 0.05, raw));
    const ux = dx / raw, uy = dy / raw;
    const along = (upper * upper + d * d - lower * lower) / (2 * d);
    const across = Math.sqrt(Math.max(0, upper * upper - along * along));
    return { x: root.x + ux * along - uy * across * side, y: root.y + uy * along + ux * across * side };
  }
  function makePose(contacts, previousTorso, swing = null) {
    const anchors = swing ? Object.fromEntries(Object.entries(contacts).filter(([limb]) => limb !== swing.limb)) : contacts;
    const solved = solveTorso(anchors, previousTorso), t = solved.torso;
    const poseContacts = { ...contacts };
    if (swing) {
      const info = limbInfo[swing.limb], root = { x: t.x + info.root[0], y: t.y + info.root[1] };
      const desired = { x: swing.from.x + (swing.target.x - swing.from.x) * swing.progress, y: swing.from.y + (swing.target.y - swing.from.y) * swing.progress };
      const dx = desired.x - root.x, dy = desired.y - root.y, d = Math.max(0.001, Math.hypot(dx, dy));
      const safeDistance = Math.min(info.upper + info.lower - 1, Math.max(Math.abs(info.upper - info.lower) + 1, d));
      poseContacts[swing.limb] = { x: root.x + dx / d * safeDistance, y: root.y + dy / d * safeDistance, id: swing.target.id };
    }
    const points = {
      pelvis: t,
      neck: { x: t.x, y: t.y + 19 },
      head: { x: t.x, y: t.y + 27 },
    };
    for (const limb of Object.keys(limbInfo)) {
      const info = limbInfo[limb], side = limb.startsWith('left') ? 'left' : 'right';
      const isArm = limb.endsWith('Hand');
      const root = { x: t.x + info.root[0], y: t.y + info.root[1] };
      const end = poseContacts[limb];
      const joint = twoBone(root, end, info.upper, info.lower, info.side);
      if (isArm) {
        points[`${side}Shoulder`] = root;
        points[`${side}Elbow`] = joint;
        points[`${side}Hand`] = end;
      } else {
        points[`${side}Hip`] = root;
        points[`${side}Knee`] = joint;
        points[`${side}Foot`] = end;
      }
    }
    return { points, torso: t, maxViolation: solved.maxViolation };
  }
  function revealBeta() {
    if (!currentProblem) return;
    clearInterval(animationTimer);
    clearInterval(betaTimer);
    const button = $('beta-button');
    button.disabled = true;
    button.textContent = 'Planning contacts…';
    $('beta-status').textContent = 'PLANNING CONTACTS';
    window.setTimeout(() => {
      const { contacts, steps, torso: initialTorso } = contactSequence(currentProblem);
      const list = $('sequence-list');
      list.replaceChildren(...steps.map((step, i) => sequenceItem(i + 1, step.id, step.limb.replace('Hand', ' hand').replace('Foot', ' foot'), step.role === 7 ? 'finish' : step.role === 8 ? 'foot' : 'hand')));
      const current = { ...contacts };
      let pose = makePose(current, initialTorso);
      let maxViolation = pose.maxViolation;
      let maxContactDrift = 0;
      let stepIndex = 0, frameIndex = 0;
      const framesPerMove = 14;
      drawBoard(currentProblem, -1, pose);
      button.textContent = 'Animating beta…';
      betaTimer = setInterval(() => {
        if (stepIndex >= steps.length) {
          clearInterval(betaTimer);
          button.disabled = false;
          button.textContent = 'Replay beta animation';
          $('beta-status').textContent = maxContactDrift > 0.1 ? 'CONTACT DRIFT' : maxViolation <= 4 ? 'FEASIBILITY CHECK PASSED' : 'POSE LIMIT WARNING';
          return;
        }
        const step = steps[stepIndex];
        const from = current[step.limb], target = posOf(step.id);
        const progress = Math.min(1, (frameIndex + 1) / framesPerMove);
        pose = makePose(current, pose.torso, { limb: step.limb, from, target, progress });
        for (const limb of Object.keys(current)) {
          if (limb === step.limb) continue;
          const endpoint = pose.points[limb];
          maxContactDrift = Math.max(maxContactDrift, Math.hypot(endpoint.x - current[limb].x, endpoint.y - current[limb].y));
        }
        maxViolation = Math.max(maxViolation, pose.maxViolation);
        $('beta-status').textContent = `MOVING ${step.limb.toUpperCase()} · ${stepIndex + 1}/${steps.length}`;
        const highlighted = currentProblem.plan.findIndex((p) => p.id === step.id);
        drawBoard(currentProblem, highlighted, pose);
        frameIndex++;
        if (frameIndex >= framesPerMove) {
          current[step.limb] = target;
          pose = makePose(current, pose.torso);
          maxViolation = Math.max(maxViolation, pose.maxViolation);
          stepIndex++;
          frameIndex = 0;
        }
      }, 42);
    }, 10);
  }
  function makeProblem() {
    const button = $('generate-button');
    if (generating) return;
    if (!dataset) { showLoadError(); return; }
    generating = true;
    button.disabled = true;
    button.querySelector('span:nth-child(2)').textContent = 'Finding a route…';
    $('board-status').textContent = 'GENERATING';
    window.setTimeout(() => {
      try {
        const result = sampleProblem();
        if (!result) {
          $('board-status').textContent = 'NO ROUTE FOUND';
          $('route-copy').textContent = 'Could not find a reachable route. Try Generate again.';
        } else renderResult(result);
      } catch (error) {
        console.error('ClimbGen route generation failed', error);
        $('board-status').textContent = 'GENERATION ERROR';
        $('beta-status').textContent = 'TRY AGAIN';
        const detail = error && typeof error.message === 'string' ? ` (${error.message})` : '';
        $('route-copy').textContent = `The route could not be generated${detail}. Please try again.`;
      } finally {
        generating = false;
        button.disabled = false;
        button.querySelector('span:nth-child(2)').textContent = 'Generate problem';
      }
    }, 40);
  }
  $('beta-button').addEventListener('click', revealBeta);
  function showLoadError() {
    $('board-status').textContent = 'DATA NOT LOADED';
    $('beta-status').textContent = 'DATA ERROR';
    $('route-copy').textContent = 'The bundled TB2 data could not be loaded. Reload the page and try again.';
    $('generate-button').disabled = false;
  }
  $('generate-button').addEventListener('click', makeProblem);
  try {
    dataset = window.CLIMBGEN_DATA;
    if (!dataset?.placements?.length || !dataset?.routes?.length || !dataset?.generated?.length) throw new Error('Bundled TB2 data is missing');
    for (const hold of dataset.placements) holdMap.set(String(hold.id), hold);
    $('route-copy').textContent = `${dataset.filtered_routes.toLocaleString()} real TB2 climbs`;
    $('route-grade').textContent = '40° · TB2 Mirror';
    $('data-count').textContent = dataset.filtered_routes.toLocaleString();
    drawBoard();
    $('generate-button').disabled = false;
  } catch (error) {
    showLoadError();
    const detail = window.CLIMBGEN_LOAD_ERROR || error?.message;
    if (detail) $('route-copy').textContent += ` (${detail})`;
  }
})();
