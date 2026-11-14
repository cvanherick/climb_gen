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
  let dataset, routeGenerator, generatedCount = 0, betaFrame = 0, betaPaused = false, betaPlaybackIndex = 0, betaResult = null, currentPose = null, generating = false, currentProblem = null;

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
      if (activeStep >= 0 && route.betaSteps?.[activeStep]) {
        const hold = holdMap.get(String(route.betaSteps[activeStep].id));
        const p = point(hold.x, hold.y);
        svg.append(svgEl('circle', { cx: p.x, cy: p.y, r: 16, class: 'active-ring' }));
      }
    }
    if (figure) {
      drawClimber(figure);
      if (!$('planner-debug').hidden && $('planner-debug').open) drawPlannerOverlay(figure);
    }
  }
  function drawPlannerOverlay(frame) {
    const diagnostics = frame.diagnostics;
    if (diagnostics?.supportHull?.length > 1) {
      const points = diagnostics.supportHull.map((p) => { const q = point(p.x, p.y); return `${q.x},${q.y}`; }).join(' ');
      svg.append(svgEl('polygon', { points, class: 'debug-support' }));
    }
    if (diagnostics?.centerOfMass) {
      const p = point(diagnostics.centerOfMass.x, diagnostics.centerOfMass.y);
      svg.append(svgEl('circle', { cx: p.x, cy: p.y, r: 5, class: 'debug-com' }));
    }
    for (const limb of ['leftHand', 'rightHand', 'leftFoot', 'rightFoot']) {
      const anchor = frame.points[limb];
      if (!anchor) continue;
      const p = point(anchor.x, anchor.y);
      svg.append(svgEl('circle', { cx: p.x, cy: p.y, r: 4, class: 'debug-contact' }));
    }
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
  function routeHolds(record) {
    return record.holds.map(([id, role]) => ({ id, role }));
  }
  async function sampleProblem() {
    const targetGrade = $('grade-select').value;
    const typedName = $('climb-name').value.trim();
    const climbName = typedName || `Climb ${String(generatedCount + 1).padStart(2, '0')}`;
    const candidate = await routeGenerator.generatePlayable(
      { grade: targetGrade, name: climbName, sequence: generatedCount },
      (variant, attempt) => ClimbGenPlanner.planAsync({ holds: routeHolds(variant) }, holdMap, {
        maxExpanded: 500, beamWidth: 24, maxDepth: 24,
        onProgress: (expanded) => { $('board-status').textContent = `CHECK ${attempt + 1} · ${expanded} STATES`; },
      }),
      { maxChecks: 8, onProgress: (attempt, total) => {
        $('board-status').textContent = `CHECKING ${attempt}/${total}`;
        $('generate-button').querySelector('span:nth-child(2)').textContent = `Checking variant ${attempt}/${total}…`;
      } },
    );
    return {
      holds: routeHolds(candidate),
      source: candidate.source,
      changed: candidate.changed,
      name: climbName,
      betaPlan: candidate.betaPlan,
    };
  }
  function renderResult(problem) {
    cancelAnimationFrame(betaFrame);
    currentProblem = problem;
    generatedCount++;
    $('route-title').textContent = problem.name;
    $('route-grade').textContent = `40° · ≈${problem.source.grade}`;
    const baseLabel = problem.source.templateKind === 'ddpm' ? 'screened model sample' : `community climb #${problem.source.templateId}`;
    $('route-copy').textContent = `${problem.holds.length} holds · fresh ${problem.source.grade} variation · based on ${baseLabel}`;
    $('hold-count').textContent = problem.holds.length;
    $('move-count').textContent = '—';
    $('data-count').textContent = dataset.filtered_routes.toLocaleString();
    $('beta-status').textContent = 'BETA HIDDEN';
    $('beta-button').hidden = false;
    $('beta-button').disabled = false;
    $('beta-button').textContent = 'Reveal beta animation';
    $('playback-controls').hidden = true;
    $('planner-debug').hidden = true;
    betaResult = null;
    currentPose = null;
    betaPlaybackIndex = 0;
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
  const posOf = (id) => holdMap.get(String(id));
  function revealBeta() {
    if (!currentProblem) return;
    cancelAnimationFrame(betaFrame);
    const button = $('beta-button');
    button.disabled = true;
    button.textContent = 'Planning contacts…';
    $('beta-status').textContent = 'SEARCHING CONTACT STATES';
    Promise.resolve(currentProblem.betaPlan || ClimbGenPlanner.planAsync(currentProblem, holdMap, { onProgress: (expanded) => { $('beta-status').textContent = `SEARCHING · ${expanded} STATES`; } })).then((result) => {
      if (!result.ok) {
        button.disabled = false;
        button.textContent = 'Try beta search again';
        $('beta-status').textContent = 'NO VALIDATED CONTACT PLAN';
        $('route-copy').textContent = `${result.reason} No substitute sequence was shown.`;
        return;
      }
      betaResult = result;
      currentProblem.betaSteps = result.steps;
      $('move-count').textContent = result.steps.length;
      const baseLabel = currentProblem.source.templateKind === 'ddpm' ? 'screened model sample' : `community climb #${currentProblem.source.templateId}`;
      $('route-copy').textContent = `${currentProblem.holds.length} holds · fresh variant based on ${baseLabel} · ${currentProblem.source.grade}`;
      $('sequence-list').replaceChildren(...result.steps.map((step, i) => sequenceItem(i + 1, step.id, step.label, step.role === 7 ? 'finish' : step.role === 8 ? 'foot' : 'hand')));
      $('planner-diagnostics').textContent = JSON.stringify({ expandedStates: result.expanded, invalidTransitions: result.invalidTransitions, planningTimeMs: result.elapsedMs, weightedCost: Number(result.cost.toFixed(2)), movementTypes: [...new Set(result.steps.map((step) => step.movementType))], feasibility: { geometry: result.diagnostics.maxReachViolation < 0.25 ? 'modeled limb reach satisfied' : 'reach warning', kinematics: result.diagnostics.maxAngleViolationDeg < 1 && result.diagnostics.maxSegmentResidual < 0.1 ? 'modeled joint and segment limits satisfied' : 'pose warning', stability: 'heuristic estimate only', physical: 'unverified; no force, friction, grip, collision, or fall simulation' }, centerOfMassApproximation: result.initialPose.diagnostics.centerOfMass, supportPolygonApproximation: result.initialPose.diagnostics.supportHull, approximateStabilityCost: result.diagnostics.maxEstimatedStabilityCost, maxReachViolation: result.diagnostics.maxReachViolation, maxJointAngleLimitViolationDeg: result.diagnostics.maxAngleViolationDeg, maxTwoSegmentLengthResidual: result.diagnostics.maxSegmentResidual }, null, 2);
      $('planner-debug').hidden = false;
      $('playback-controls').hidden = false;
      button.disabled = false;
      button.textContent = 'Replay beta animation';
      playBeta(0);
    });
  }
  function playBeta(startIndex = 0) {
    if (!betaResult?.ok) return;
    cancelAnimationFrame(betaFrame);
    betaPaused = false;
    $('playback-toggle').textContent = 'Pause';
    let stepIndex = startIndex, started = null;
    betaPlaybackIndex = startIndex;
    let current = { ...betaResult.initialContacts };
    let pose = betaResult.initialPose;
    for (let i = 0; i < startIndex; i++) { current = { ...betaResult.steps[i].contacts }; pose = betaResult.steps[i].pose; }
    const tick = (now) => {
      if (betaPaused) return;
      if (stepIndex >= betaResult.steps.length) {
        betaPlaybackIndex = stepIndex;
        drawBoard(currentProblem, -1, pose);
        $('beta-status').textContent = betaResult.diagnostics.maxReachViolation < 0.25 && betaResult.diagnostics.maxAngleViolationDeg < 1 ? 'MODELED KINEMATIC LIMITS · PHYSICS UNVERIFIED' : 'POSE WARNINGS · PHYSICS UNVERIFIED';
        return;
      }
      const step = betaResult.steps[stepIndex];
      if (started == null) started = now;
      const duration = 520 / Number($('playback-speed').value || 1);
      const t = Math.min(1, (now - started) / duration);
      const from = posOf(current[step.limb]), target = posOf(step.id);
      const swingId = `swing:${stepIndex}`;
      const movingPlacements = new Map(holdMap);
      movingPlacements.set(swingId, { x: from.x + (target.x - from.x) * t, y: from.y + (target.y - from.y) * t });
      const frameContacts = { ...current, [step.limb]: swingId };
      pose = ClimbGenIK.solve(frameContacts, movingPlacements, pose.torso, { overhangDeg: 40, iterations: 6 });
      currentPose = pose;
      $('beta-status').textContent = `${step.movementType.toUpperCase()} · ${step.label.toUpperCase()} · ${stepIndex + 1}/${betaResult.steps.length}`;
      drawBoard(currentProblem, stepIndex, pose);
      if (t >= 1) {
        current = { ...step.contacts };
        pose = step.pose;
        stepIndex++;
        betaPlaybackIndex = stepIndex;
        started = null;
      }
      betaFrame = requestAnimationFrame(tick);
    };
    betaFrame = requestAnimationFrame(tick);
  }
  $('playback-toggle').addEventListener('click', () => {
    betaPaused = !betaPaused;
    $('playback-toggle').textContent = betaPaused ? 'Play' : 'Pause';
    if (!betaPaused) playBeta(betaPlaybackIndex);
  });
  $('playback-replay').addEventListener('click', () => playBeta(0));
  $('planner-debug').addEventListener('toggle', () => {
    if ($('planner-debug').open && currentProblem && currentPose) drawBoard(currentProblem, -1, currentPose);
  });
  function makeProblem() {
    const button = $('generate-button');
    if (generating) return;
    if (!dataset) { showLoadError(); return; }
    generating = true;
    button.disabled = true;
    button.querySelector('span:nth-child(2)').textContent = 'Finding a route…';
    $('board-status').textContent = 'GENERATING';
    window.setTimeout(async () => {
      try {
        const result = await sampleProblem();
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
    if (!dataset?.placements?.length || !dataset?.routes?.length) throw new Error('Bundled TB2 data is missing');
    for (const hold of dataset.placements) holdMap.set(String(hold.id), hold);
    routeGenerator = ClimbGenRouteGenerator.create(dataset);
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
