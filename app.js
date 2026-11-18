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
  let holdProfileRevision = 0;
  let dataset, routeGenerator, generatedCount = 0, betaFrame = 0, betaPaused = false, betaPlaybackIndex = 0, betaResult = null, betaAlternatives = [], activeBetaIndex = 0, currentPose = null, generating = false, currentProblem = null;

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
        const profile = position.profile;
        if ($('hold-vectors')?.checked && profile && !profile.unknown) {
          const end = point(position.x + profile.pull.x * 5, position.y + profile.pull.y * 5);
          const dx = end.x - p.x, dy = end.y - p.y, angle = Math.atan2(dy, dx);
          const arrow = svgEl('path', { d: `M ${p.x} ${p.y} L ${end.x} ${end.y} M ${end.x - 4 * Math.cos(angle - 0.6)} ${end.y - 4 * Math.sin(angle - 0.6)} L ${end.x} ${end.y} L ${end.x - 4 * Math.cos(angle + 0.6)} ${end.y - 4 * Math.sin(angle + 0.6)}`, fill: 'none', stroke: profile.verified ? '#a9e84a' : '#ffba68', 'stroke-width': 1.7, 'pointer-events': 'none' });
          svg.append(arrow);
        }
        ring.addEventListener('click', () => { $('hold-profile-select').value = String(hold.id); $('hold-profile-select').dispatchEvent(new Event('change')); });
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
    const outline = [p.leftShoulder, p.rightShoulder, p.rightHip, p.leftHip].map(q => { const v = point(q.x, q.y); return `${v.x},${v.y}`; }).join(' ');
    svg.append(svgEl('polygon', { points: outline, class: 'climber-torso' }));
    line(p.neck, p.head, 'climber-neck');
    line(p.leftShoulder, p.rightShoulder, 'climber-body');
    line(p.leftHip, p.rightHip, 'climber-body');
    for (const side of ['left', 'right']) {
      line(p[`${side}Shoulder`], p[`${side}Elbow`]);
      line(p[`${side}Elbow`], p[`${side}Wrist`] || p[`${side}Hand`]);
      const hand = frame.hands?.[side];
      if (hand) {
        line(hand.wrist, hand.contact, 'climber-digit');
        dot(hand.wrist, 2);
        for (const finger of hand.fingers) for (let i = 1; i < finger.length; i++) line(finger[i - 1], finger[i], 'climber-digit');
      }
      line(p[`${side}Hip`], p[`${side}Knee`], 'climber-leg');
      line(p[`${side}Knee`], p[`${side}Ankle`] || p[`${side}Foot`], 'climber-leg');
      const foot = frame.feet?.[side];
      if (foot) {
        line(foot.heel, foot.ankle, 'climber-digit');
        line(foot.ankle, foot.toe, 'climber-digit');
        line(foot.toe, foot.heel, 'climber-digit');
        dot(foot.ankle, 2);
      }
      dot(p[`${side}Elbow`], 3);
      dot(p[`${side}Knee`], 3);
    }
    dot(p.pelvis, 4);
    dot(p.head, 12, 'climber-head');
  }
  function routeHolds(record) {
    return record.holds.map(([id, role]) => ({ id, role }));
  }
  async function sampleProblem() {
    const targetGrade = $('grade-select').value;
    const climbStyle = $('style-select').value;
    const typedName = $('climb-name').value.trim();
    const climbName = typedName || `Climb ${String(generatedCount + 1).padStart(2, '0')}`;
    const candidate = await routeGenerator.generatePlayable(
      { grade: targetGrade, name: climbName, sequence: generatedCount, style: climbStyle },
      (variant, attempt) => ClimbGenPlanner.planAsync({ holds: routeHolds(variant) }, holdMap, {
        maxExpanded: 500, beamWidth: 24, maxDepth: 24, style: climbStyle,
        onProgress: (expanded) => { $('board-status').textContent = `CHECK ${attempt + 1} · ${expanded} STATES`; },
      }),
      { maxChecks: 8, styleCandidates: climbStyle === 'any' ? 1 : 3, onProgress: (attempt, total) => {
        $('board-status').textContent = `CHECKING ${attempt}/${total}`;
        $('generate-button').querySelector('span:nth-child(2)').textContent = `Checking variant ${attempt}/${total}…`;
      } },
    );
    return {
      holds: routeHolds(candidate),
      source: candidate.source,
      changed: candidate.changed,
      evaluation: candidate.evaluation,
      style: climbStyle,
      styleFit: candidate.styleFit,
      name: climbName,
      betaPlan: candidate.betaPlan,
    };
  }
  function renderResult(problem) {
    cancelAnimationFrame(betaFrame);
    currentProblem = problem;
    generatedCount++;
    $('route-title').textContent = problem.name;
    $('route-grade').textContent = `40° · TARGET ${problem.source.grade}`;
    const baseLabel = problem.source.templateKind === 'ddpm' ? 'screened model sample' : `community climb #${problem.source.templateId}`;
    const modelReadout = problem.evaluation
      ? ` · learned estimate ${problem.evaluation.predictedGrade} · community quality estimate ${problem.evaluation.quality.toFixed(1)}/5`
      : '';
    const styleReadout = problem.style === 'dynamic' ? ' · dyno-like, sparse holds, longer reach bias'
      : problem.style === 'static' ? ' · static, shorter controlled reaches' : '';
    $('route-copy').textContent = `${problem.holds.length} holds · grade-conditioned ${problem.source.grade} variation${styleReadout}${modelReadout} · based on ${baseLabel}`;
    $('beta-note').textContent = problem.style === 'dynamic'
      ? 'Dyno-like routes keep at most three middle hand holds and two footholds, favoring longer reach-checked moves. The animation does not model jumping or momentum.'
      : problem.style === 'static'
        ? 'Static style favors shorter, controlled reaches. Beta still uses 2D reach and support heuristics, not real-world physics.'
        : 'Beta uses 2D reach and support heuristics. Contact plans are not verified for force, grip, or real-world safety.';
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
    betaAlternatives = [];
    activeBetaIndex = 0;
    $('playback-alternative').textContent = 'Alternative beta';
    $('playback-alternative').disabled = true;
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
    const revision = holdProfileRevision, problem = currentProblem;
    Promise.resolve(currentProblem.betaPlan || ClimbGenPlanner.planAsync(currentProblem, holdMap, { style: currentProblem.style, onProgress: (expanded) => { $('beta-status').textContent = `SEARCHING · ${expanded} STATES`; } })).then((result) => {
      if (revision !== holdProfileRevision || problem !== currentProblem) return;
      if (!result.ok) {
        button.disabled = false;
        button.textContent = 'Try beta search again';
        $('beta-status').textContent = 'NO VALIDATED CONTACT PLAN';
        $('route-copy').textContent = `${result.reason} No substitute sequence was shown.`;
        return;
      }
      betaResult = result;
      betaAlternatives = result.alternatives || [result];
      activeBetaIndex = 0;
      $('playback-alternative').disabled = betaAlternatives.length < 2;
      $('playback-alternative').textContent = betaAlternatives.length > 1 ? `Beta 1 / ${betaAlternatives.length} · next` : 'One beta found';
      currentProblem.betaSteps = result.steps;
      $('move-count').textContent = result.steps.length;
      const baseLabel = currentProblem.source.templateKind === 'ddpm' ? 'screened model sample' : `community climb #${currentProblem.source.templateId}`;
      const styleReadout = currentProblem.style === 'dynamic' ? ' · dyno-like, sparse holds, longer reach bias'
        : currentProblem.style === 'static' ? ' · static, shorter controlled reaches' : '';
      $('route-copy').textContent = `${currentProblem.holds.length} holds · fresh ${currentProblem.source.grade} variant${styleReadout} · based on ${baseLabel}`;
      $('sequence-list').replaceChildren(...result.steps.map((step, i) => sequenceItem(i + 1, step.id, step.label, step.role === 7 ? 'finish' : step.role === 8 ? 'foot' : 'hand')));
      $('planner-diagnostics').textContent = JSON.stringify({ expandedStates: result.expanded, invalidTransitions: result.invalidTransitions, planningTimeMs: result.elapsedMs, weightedCost: Number(result.cost.toFixed(2)), holdDirectionCost: result.diagnostics.maxHoldDirectionCost, holdDifficultySource: 'provisional manufacturer-chart tiers; grade model uses community route labels', movementTypes: [...new Set(result.steps.map((step) => step.movementType))], feasibility: { geometry: result.diagnostics.maxReachViolation < 0.25 ? 'modeled limb reach satisfied' : 'reach warning', kinematics: result.diagnostics.maxAngleViolationDeg < 1 && result.diagnostics.maxSegmentResidual < 0.1 ? 'modeled joint and segment limits satisfied' : 'pose warning', stability: 'heuristic estimate only', physical: 'unverified; no force, friction, grip, collision, or fall simulation' }, centerOfMassApproximation: result.initialPose.diagnostics.centerOfMass, supportPolygonApproximation: result.initialPose.diagnostics.supportHull, approximateStabilityCost: result.diagnostics.maxEstimatedStabilityCost, maxReachViolation: result.diagnostics.maxReachViolation, maxJointAngleLimitViolationDeg: result.diagnostics.maxAngleViolationDeg, maxTwoSegmentLengthResidual: result.diagnostics.maxSegmentResidual }, null, 2);
      $('planner-debug').hidden = false;
      $('playback-controls').hidden = false;
      button.disabled = false;
      button.textContent = 'Replay beta animation';
      playBeta(0);
    });
  }
  let betaTimeline = null;
  const betaClock = ClimbGenAnimation.clock();
  function playBeta(startIndex = 0, resume = false) {
    if (!betaResult?.ok) return;
    cancelAnimationFrame(betaFrame);
    if (!resume || !betaTimeline) {
      betaTimeline = ClimbGenAnimation.create(betaResult, holdMap);
      betaClock.reset(betaTimeline.segments[startIndex]?.start || 0);
    }
    betaPaused = false;
    $('playback-toggle').textContent = 'Pause';
    const tick = (now) => {
      if (betaPaused) return;
      const elapsed = betaClock.tick(now, Number($('playback-speed').value || 1));
      const frame = betaTimeline.sample(elapsed);
      currentPose = frame.pose;
      betaPlaybackIndex = frame.stepIndex;
      drawBoard(currentProblem, frame.done ? -1 : frame.stepIndex, frame.pose);
      if (frame.done) {
        betaPaused = true;
        betaClock.pause();
        $('playback-toggle').textContent = 'Replay';
        $('beta-status').textContent = 'BETA COMPLETE · GEOMETRIC ANIMATION';
        return;
      }
      const step = betaResult.steps[frame.stepIndex];
      $('beta-status').textContent = `${frame.phase.toUpperCase()} · ${step.label.toUpperCase()} · ${frame.stepIndex + 1}/${betaResult.steps.length}`;
      betaFrame = requestAnimationFrame(tick);
    };
    betaFrame = requestAnimationFrame(tick);
  }
  $('playback-toggle').addEventListener('click', () => {
    if (!betaResult?.ok) return;
    if (betaPaused) {
      if (betaClock.elapsed >= betaTimeline?.duration) playBeta(0);
      else playBeta(0, true);
    } else {
      betaPaused = true;
      betaClock.pause();
      cancelAnimationFrame(betaFrame);
      $('playback-toggle').textContent = 'Play';
    }
  });
  $('playback-replay').addEventListener('click', () => playBeta(0));
  $('playback-alternative').addEventListener('click', () => {
    if (betaAlternatives.length < 2) return;
    activeBetaIndex = (activeBetaIndex + 1) % betaAlternatives.length;
    betaResult = betaAlternatives[activeBetaIndex];
    currentProblem.betaPlan = betaResult;
    currentProblem.betaSteps = betaResult.steps;
    $('playback-alternative').textContent = `Beta ${activeBetaIndex + 1} / ${betaAlternatives.length} · next`;
    $('move-count').textContent = betaResult.steps.length;
    $('sequence-list').replaceChildren(...betaResult.steps.map((step, i) => sequenceItem(i + 1, step.id, step.label, step.role === 7 ? 'finish' : step.role === 8 ? 'foot' : 'hand')));
    playBeta(0);
  });
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

  function initHoldProfiles() {
    const storageKey = 'climbgen-reviewed-hold-directions-v1';
    let annotations = {};
    let status = '';
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored) annotations = ClimbGenHoldProfiles.parseAnnotations(JSON.parse(stored));
    } catch (_) { status = 'Saved directions were unavailable; using original estimates.'; }
    ClimbGenHoldProfiles.apply(holdMap, window.CLIMBGEN_HOLD_PROFILES, annotations);
    const select = $('hold-profile-select');
    for (const hold of holdMap.values()) {
      const option = document.createElement('option');
      option.value = hold.id;
      option.textContent = `#${hold.id} · ${hold.profile.material}`;
      select.append(option);
    }
    const preview = () => {
      const hold = holdMap.get(select.value), profile = hold.profile;
      const crop = $('hold-profile-crop');
      const atlas = window.CLIMBGEN_ASSETS?.holdAtlas || './assets/tb2-hold-crops-atlas.webp';
      crop.style.backgroundImage = `url("${atlas}")`;
      crop.style.backgroundPosition = `${-(profile.atlasIndex % 16) * 64}px ${-Math.floor(profile.atlasIndex / 16) * 64}px`;
      crop.setAttribute('aria-label', `Screenshot crop of hold #${hold.id}`);
      $('hold-profile-info').textContent = `${profile.material} · ${profile.unknown ? 'direction unresolved' : profile.verified ? 'reviewed direction' : 'low-confidence direction estimate'}. No measured grip strength.`;
      const difficulty = hold.difficulty;
      const tiers = ['Easy','Intermediate','Advanced','Hard'];
      if (difficulty) $('hold-profile-info').textContent += ` Shape ${difficulty.shape}. Hand tier: ${difficulty.handTier == null ? 'unknown' : tiers[difficulty.handTier] + ' (chart-derived)'}.` ;
      if (difficulty?.footApproaches?.length) $('hold-profile-info').textContent += ` Foot tier varies by approach: ${[...new Set(difficulty.footApproaches.map(a=>tiers[a.tier]))].join(' / ')} (provisional).`;
    };
    const refresh = () => {
      holdProfileRevision++;
      cancelAnimationFrame(betaFrame);
      betaResult = null; betaAlternatives = []; currentPose = null;
      if (currentProblem) {
        currentProblem.betaPlan = null;
        currentProblem.betaSteps = null;
        $('beta-button').disabled = false;
        $('beta-button').textContent = 'Replan beta with updated directions';
        $('beta-status').textContent = 'DIRECTIONS UPDATED · REPLAN BETA';
        $('playback-controls').hidden = true;
        $('planner-debug').hidden = true;
        $('sequence-list').replaceChildren(sequenceItem(null, null, 'Reveal beta to update contacts', 'empty'));
        $('move-count').textContent = '—';
      }
      preview(); drawBoard(currentProblem);
    };
    select.addEventListener('change', preview);
    $('hold-vectors').addEventListener('change', () => drawBoard(currentProblem, -1, currentPose));
    $('hold-profile-import').addEventListener('change', async (event) => {
      if (generating) { $('hold-profile-status').textContent = 'Wait for generation to finish before importing directions.'; event.target.value = ''; return; }
      const file = event.target.files[0];
      if (!file) return;
      try {
        if (file.size > 2000000) throw new Error('Direction JSON is too large.');
        const document = JSON.parse(await file.text());
        if (generating) throw new Error('Wait for generation to finish before importing directions.');
        annotations = ClimbGenHoldProfiles.parseAnnotations(document);
        ClimbGenHoldProfiles.apply(holdMap, window.CLIMBGEN_HOLD_PROFILES, annotations);
        let saved = true;
        try { localStorage.setItem(storageKey, JSON.stringify({ layout_id: 10, reviewed_annotations: annotations })); } catch (_) { saved = false; }
        $('hold-profile-status').textContent = `Imported ${Object.keys(annotations).length} annotations${saved ? '.' : ' for this session; browser storage unavailable.'}`;
        refresh();
      } catch (error) { $('hold-profile-status').textContent = error.message; }
      event.target.value = '';
    });
    $('hold-profile-reset').addEventListener('click', () => {
      if (generating) return;
      annotations = {};
      try { localStorage.removeItem(storageKey); } catch (_) {}
      ClimbGenHoldProfiles.apply(holdMap);
      $('hold-profile-status').textContent = 'Using original screenshot estimates.';
      refresh();
    });
    $('hold-profile-status').textContent = status || `498 mapped holds · ${Object.keys(annotations).length} annotations applied.`;
    preview();
  }

  function initPhotoBuilder() {
    const main = document.querySelector('main.page');
    if (!main) return;
    main.insertAdjacentHTML('beforeend', `
      <section id="photo-view" class="app-view" hidden>
      <button id="photo-home" class="back-home" type="button">← All tools</button>
      <section class="photo-builder" aria-labelledby="photo-builder-title">
        <div class="photo-builder-heading"><div><p class="eyebrow">EXPERIMENTAL TOOL</p><h2 id="photo-builder-title">Build a sequence on your wall</h2><p>Upload a wall photo, mark holds, choose a start, then explore next-hold suggestions.</p></div><span class="photo-angle">PHOTO MODE</span></div>
        <div class="photo-builder-controls"><label class="photo-upload">Choose wall photo<input id="photo-file" type="file" accept="image/*" /></label><div class="photo-tools"><button type="button" id="photo-detect" class="photo-tool photo-detect" disabled>Scan wall holds</button><button type="button" id="photo-calibrate-mode" class="photo-tool">Mark wall corners</button><button type="button" id="photo-mark-mode" class="photo-tool active">Add missed holds</button><button type="button" id="photo-remove-mode" class="photo-tool">Remove false marks</button><button type="button" id="photo-start-mode" class="photo-tool">Select start</button><button type="button" id="photo-reset-plane" class="photo-tool" disabled>Reset corners</button><button type="button" id="photo-undo" class="photo-tool" disabled>Undo</button><button type="button" id="photo-clear" class="photo-tool">Clear holds</button></div></div>
        <div class="photo-analysis" aria-label="Photo analysis status"><div><span>WALL PLANE</span><b id="photo-plane-status">Not calibrated</b></div><div><span>USER-SET WALL ANGLE</span><b id="photo-angle-status">Unknown</b></div><div><span>HOLD DETECTION</span><b id="photo-detection-status">Waiting for photo</b></div><p id="photo-analysis-note">The uploaded photo stays in this browser. For cleaner results, mark the four wall corners; detection will ignore everything outside that wall. Local contrast and color segmentation proposes hold outlines, which still need review.</p></div>
        <div class="photo-angle-control"><label for="photo-wall-type">Wall angle</label><select id="photo-wall-type"><option value="unknown">Unknown</option><option value="-10">Slab (approx.)</option><option value="0">Vertical</option><option value="40">Overhang (approx.)</option></select><label for="photo-wall-angle">Known degrees from vertical</label><input id="photo-wall-angle" type="number" min="-20" max="70" step="1" placeholder="Optional" /></div>
        <p id="photo-status" class="photo-status" aria-live="polite">Choose a photo to begin. Your image stays in this browser session.</p>
        <div class="photo-workspace"><div class="photo-preview"><div id="photo-stage" class="photo-stage"><img id="photo-image" alt="Uploaded climbing wall" hidden /><svg id="photo-overlay" viewBox="0 0 100 100" preserveAspectRatio="none" aria-label="Clickable photo hold annotations"></svg><div id="photo-empty" class="photo-empty">Your wall photo will appear here</div></div></div><aside class="photo-sequence"><div class="photo-sequence-top"><h3>Sequence</h3><button type="button" id="photo-suggest" class="photo-suggest" disabled>Suggest next holds</button></div><ol id="photo-sequence-list"><li class="photo-sequence-empty">Select one marked hold as the start.</li></ol><div id="photo-choices" class="photo-choices"></div><p class="photo-disclaimer">Suggestions use marked photo positions and simple distance/progress heuristics. They are not generated by a trained photo model and do not verify reachability, hold quality, or safety.</p></aside></div>
      </section>
      </section>`);

    const file = $('photo-file'), image = $('photo-image'), overlay = $('photo-overlay');
    const stage = $('photo-stage'), status = $('photo-status'), suggest = $('photo-suggest');
    const sequenceList = $('photo-sequence-list'), choices = $('photo-choices');
    const wallType = $('photo-wall-type'), wallAngle = $('photo-wall-angle');
    const holds = [], corners = [];
    let sequence = [], mode = 'mark', objectUrl = null, finished = null, homography = null, detecting = false;
    const cornerNames = ['top-left', 'top-right', 'bottom-right', 'bottom-left'];
    function solveLinear(matrix, rhs) {
      const a = matrix.map((row, i) => [...row, rhs[i]]);
      for (let col = 0; col < a.length; col++) {
        let pivot = col;
        for (let row = col + 1; row < a.length; row++) if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
        if (Math.abs(a[pivot][col]) < 1e-9) return null;
        [a[col], a[pivot]] = [a[pivot], a[col]];
        const scale = a[col][col];
        for (let j = col; j <= a.length; j++) a[col][j] /= scale;
        for (let row = 0; row < a.length; row++) {
          if (row === col) continue;
          const factor = a[row][col];
          for (let j = col; j <= a.length; j++) a[row][j] -= factor * a[col][j];
        }
      }
      return a.map((row) => row[a.length]);
    }
    function pointInImage(p) { return Number.isFinite(p?.x) && Number.isFinite(p?.y) && p.x >= 0 && p.x <= 100 && p.y >= 0 && p.y <= 100; }
    function quadrilateralIsValid(points) {
      if (points.length !== 4 || !points.every(pointInImage)) return false;
      const cross = (a, b, c) => (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
      const signs = points.map((p, i) => Math.sign(cross(p, points[(i + 1) % 4], points[(i + 2) % 4])));
      const area = Math.abs(points.reduce((sum, p, i) => sum + p.x * points[(i + 1) % 4].y - points[(i + 1) % 4].x * p.y, 0)) / 2;
      return area >= 350 && signs.every((sign) => sign !== 0 && sign === signs[0]);
    }
    function makeHomography(points) {
      const dest = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
      const matrix = [], rhs = [];
      points.forEach((p, i) => {
        const { x: u, y: v } = dest[i];
        matrix.push([p.x, p.y, 1, 0, 0, 0, -u * p.x, -u * p.y]); rhs.push(u);
        matrix.push([0, 0, 0, p.x, p.y, 1, -v * p.x, -v * p.y]); rhs.push(v);
      });
      const h = solveLinear(matrix, rhs);
      if (!h) return null;
      return (p) => {
        const denominator = h[6] * p.x + h[7] * p.y + 1;
        if (Math.abs(denominator) < 1e-8) return null;
        const x = (h[0] * p.x + h[1] * p.y + h[2]) / denominator;
        const y = (h[3] * p.x + h[4] * p.y + h[5]) / denominator;
        return Number.isFinite(x) && Number.isFinite(y) ? { x: Math.max(0, Math.min(100, x)), y: Math.max(0, Math.min(100, y)) } : null;
      };
    }
    function updatePlaneStatus() {
      $('photo-reset-plane').disabled = corners.length === 0;
      const angle = Number(wallAngle.value);
      const categoryAngle = wallType.value === 'unknown' ? null : Number(wallType.value);
      const selectedAngle = wallAngle.value.trim() !== '' && Number.isFinite(angle) ? angle : categoryAngle;
      $('photo-angle-status').textContent = selectedAngle == null ? 'Unknown' : `${selectedAngle}° ${selectedAngle > 0 ? 'overhang' : selectedAngle < 0 ? 'slab' : 'vertical'}`;
      if (homography) {
        $('photo-plane-status').textContent = 'Rectified from 4 corners';
        $('photo-analysis-note').textContent = 'Detection is restricted to the four marked wall corners. Hold positions are perspective-rectified; physical wall angle and scale remain unknown. Review each outline and correct it as needed.';
      } else {
        $('photo-plane-status').textContent = corners.length ? `${corners.length}/4 corners marked` : 'Not calibrated';
        $('photo-analysis-note').textContent = 'For cleaner detection, mark the four wall corners; the next scan ignores everything outside that wall. Local contrast and color segmentation proposes hold outlines; review them, remove false marks, and add missed holds. Calibration corrects perspective but does not estimate physical wall inclination or distance.';
      }
    }
    const setMode = (next) => {
      mode = next;
      $('photo-calibrate-mode').classList.toggle('active', mode === 'calibrate');
      $('photo-mark-mode').classList.toggle('active', mode === 'mark');
      $('photo-remove-mode').classList.toggle('active', mode === 'remove');
      $('photo-start-mode').classList.toggle('active', mode === 'start');
      stage.classList.toggle('photo-remove-mode', mode === 'remove');
      status.textContent = mode === 'calibrate'
        ? `Tap wall corners in order: ${cornerNames[corners.length] || 'calibration complete'}.`
        : mode === 'mark' ? 'Tap the center of any missed hold to add it.'
          : mode === 'remove' ? 'Tap a false detected hold to remove it.'
            : 'Tap one detected hold to select the start.';
    };
    const draw = () => {
      overlay.replaceChildren();
      if (corners.length) {
        const polyline = svgEl('polyline', { points: [...corners.map((p) => `${p.x},${p.y}`), ...(homography ? [`${corners[0].x},${corners[0].y}`] : [])].join(' '), class: 'photo-plane-outline' });
        overlay.append(polyline);
        corners.forEach((corner, index) => {
          const dot = svgEl('circle', { cx: corner.x, cy: corner.y, r: 1.7, class: 'photo-corner-dot' });
          const label = svgEl('text', { x: corner.x, y: corner.y - 2, class: 'photo-corner-label', 'text-anchor': 'middle', 'pointer-events': 'none' });
          label.textContent = String(index + 1);
          overlay.append(dot, label);
        });
      }
      holds.forEach((hold, index) => {
        const routeClass = `${sequence.includes(index) ? ' in-sequence' : ''}${sequence[0] === index ? ' photo-start-dot' : ''}${index === finished ? ' photo-finish-dot' : ''}${hold.source === 'auto' ? ' auto-detected' : ' manual'}`;
        if (Array.isArray(hold.polygon) && hold.polygon.length >= 3) {
          const points = hold.polygon.map((point) => `${point.x},${point.y}`).join(' ');
          const shadow = svgEl('polygon', { points, class: `photo-hold-outline-shadow${routeClass}`, 'data-index': index });
          const outline = svgEl('polygon', { points, class: `photo-hold-outline${routeClass}`, 'data-index': index });
          overlay.append(shadow, outline);
        } else {
          const circle = svgEl('circle', { cx: hold.x, cy: hold.y, r: 2, class: `photo-hold-dot${routeClass}`, 'data-index': index });
          overlay.append(circle);
        }
      });
      sequenceList.replaceChildren();
      if (!sequence.length) {
        const empty = document.createElement('li'); empty.className = 'photo-sequence-empty'; empty.textContent = 'Select one marked hold as the start.'; sequenceList.append(empty);
      } else sequence.forEach((index, i) => {
        const li = document.createElement('li');
        li.innerHTML = `<span>${i === 0 ? 'START' : index === finished ? 'FINISH' : `MOVE ${i}`}</span><b>Hold ${index + 1}</b><button type="button" aria-label="Remove hold ${index + 1}" data-remove="${i}">×</button>`;
        sequenceList.append(li);
      });
      sequenceList.querySelectorAll('[data-remove]').forEach((button) => button.addEventListener('click', () => {
        const index = Number(button.dataset.remove);
        if (index === 0) sequence = [];
        else sequence.splice(index);
        if (!sequence.includes(finished)) finished = null;
        choices.replaceChildren(); draw();
      }));
      $('photo-undo').disabled = holds.length === 0 || detecting;
      $('photo-detect').disabled = image.hidden || detecting;
      $('photo-detect').textContent = detecting ? 'Scanning…' : 'Scan wall holds';
      suggest.disabled = !sequence.length || holds.length < 2 || finished != null;
      suggest.textContent = finished == null ? 'Suggest next holds' : 'Sequence finished';
      updatePlaneStatus();
    };
    file.addEventListener('change', () => {
      const selected = file.files?.[0];
      if (!selected) return;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = URL.createObjectURL(selected);
      image.onload = () => {
        image.hidden = false; $('photo-empty').hidden = true; stage.classList.add('has-photo');
        status.textContent = 'Photo loaded locally. Mark the four wall corners; hold detection will run inside that area.';
        $('photo-detection-status').textContent = 'Mark wall corners';
        setMode('calibrate');
        draw();
      };
      image.onerror = () => { status.textContent = 'That image could not be opened. Choose another photo.'; };
      image.src = objectUrl;
      holds.length = 0; corners.length = 0; homography = null; sequence = []; finished = null; setMode('mark'); choices.replaceChildren(); draw();
    });
    overlay.addEventListener('click', (event) => {
      if (!image.src || image.hidden) return;
      const rect = overlay.getBoundingClientRect();
      const x = Math.max(0, Math.min(100, (event.clientX - rect.left) / rect.width * 100));
      const y = Math.max(0, Math.min(100, (event.clientY - rect.top) / rect.height * 100));
      if (mode === 'calibrate') {
        if (corners.length >= 4) { status.textContent = 'Wall plane calibrated. Reset corners to mark them again.'; return; }
        corners.push({ x, y });
        if (corners.length === 4) {
          if (!quadrilateralIsValid(corners)) {
            corners.pop();
            status.textContent = 'Those corners do not form a usable convex wall outline. Tap the fourth corner again.';
          } else {
            homography = makeHomography(corners);
            if (!homography) { corners.pop(); status.textContent = 'Could not solve that wall outline. Tap the fourth corner again.'; }
            else { status.textContent = 'Wall plane marked. Re-scanning inside its four corners…'; setMode('mark'); autoDetectHolds(); }
          }
        } else status.textContent = `Corner ${corners.length} marked. Next: ${cornerNames[corners.length]}.`;
      } else if (mode === 'mark') {
        holds.push({ x, y, source: 'manual' });
        status.textContent = `${holds.length} hold${holds.length === 1 ? '' : 's'} marked.`;
      } else {
        const mark = event.target.closest('[data-index]');
        if (!mark) { status.textContent = mode === 'remove' ? 'Tap a hold outline to remove it.' : 'Tap one hold outline to select the start.'; return; }
        const index = Number(mark.dataset.index);
        if (mode === 'remove') {
          removeHold(index);
          status.textContent = 'Hold mark removed. Select another false mark or switch modes.';
          draw();
          return;
        }
        sequence = [index]; finished = null; choices.replaceChildren();
        status.textContent = `Hold ${sequence[0] + 1} selected as the start.`;
      }
      draw();
    });
    $('photo-calibrate-mode').addEventListener('click', () => { if (!image.src || image.hidden) { status.textContent = 'Choose a wall photo before calibrating its plane.'; return; } if (corners.length >= 4) { status.textContent = 'Reset the corners to calibrate again.'; return; } setMode('calibrate'); });
    $('photo-mark-mode').addEventListener('click', () => setMode('mark'));
    $('photo-remove-mode').addEventListener('click', () => setMode('remove'));
    $('photo-start-mode').addEventListener('click', () => setMode('start'));
    $('photo-reset-plane').addEventListener('click', () => { corners.length = 0; homography = null; choices.replaceChildren(); draw(); setMode('calibrate'); });
    const clearSuggestions = () => { choices.replaceChildren(); };
    const updateAngle = () => { clearSuggestions(); updatePlaneStatus(); };
    wallType.addEventListener('change', updateAngle);
    wallAngle.addEventListener('input', updateAngle);
    function removeHold(index) {
      if (index < 0 || index >= holds.length) return;
      holds.splice(index, 1);
      const routePosition = sequence.indexOf(index);
      if (routePosition >= 0) {
        sequence = sequence.slice(0, routePosition);
        finished = null;
      } else {
        sequence = sequence.map((value) => value > index ? value - 1 : value);
        if (finished === index) finished = null;
        else if (finished > index) finished--;
      }
      choices.replaceChildren();
    }
    async function autoDetectHolds() {
      if (!image.src || image.hidden) return;
      if (corners.length !== 4) {
        $('photo-detection-status').textContent = 'Mark wall corners first';
        status.textContent = 'Tap Mark wall corners and select the four wall corners in order. The scan will ignore everything outside the wall.';
        setMode('calibrate');
        return;
      }
      const detector = window.ClimbGenPhotoDetector;
      if (!detector?.detect) {
        $('photo-detection-status').textContent = 'Detector unavailable';
        status.textContent = 'Automatic hold detection is unavailable in this build. Add missed holds manually.';
        return;
      }
      detecting = true;
      $('photo-detect').disabled = true;
      $('photo-detect').textContent = 'Scanning…';
      $('photo-detection-status').textContent = 'Detecting on device…';
      status.textContent = 'Scanning the photo for hold outlines…';
      try {
        const result = await detector.detect(image, { maxCandidates: 220, maxSide: 720, minConfidence: 0.42, wallPolygon: corners.length === 4 ? corners : undefined });
        const detected = Array.isArray(result?.candidates) ? result.candidates
          : Array.isArray(result?.holds) ? result.holds
            : Array.isArray(result) ? result : [];
        const autoHolds = detected.filter((hold) => Number.isFinite(Number(hold.x)) && Number.isFinite(Number(hold.y)))
          .map((hold) => ({ ...hold, x: Math.max(0, Math.min(100, Number(hold.x))), y: Math.max(0, Math.min(100, Number(hold.y))), source: 'auto' }));
        const manualHolds = holds.filter((hold) => hold.source !== 'auto');
        holds.splice(0, holds.length, ...manualHolds, ...autoHolds);
        sequence = [];
        finished = null;
        choices.replaceChildren();
        if (!autoHolds.length) {
          $('photo-detection-status').textContent = 'No holds found';
          status.textContent = 'No hold candidates were found. Add holds manually or try a clearer, straighter-on photo.';
        } else {
          const confidenceValues = autoHolds.map((hold) => Number(hold.confidence)).filter(Number.isFinite);
          const average = confidenceValues.length ? confidenceValues.reduce((sum, value) => sum + value, 0) / confidenceValues.length : null;
          $('photo-detection-status').textContent = `${autoHolds.length} candidates${result?.method ? ` · ${result.method}` : ''}`;
          status.textContent = `Outlined ${autoHolds.length} hold candidates${average == null ? '' : ` · ${Math.round(average * 100)}% score`} inside the marked wall. Remove false outlines or add missed holds. Detection runs locally with image contrast and color boundaries; it is not yet a trained climbing-wall model.${result?.note ? ` ${result.note}` : ''}`;
        }
      } catch (error) {
        $('photo-detection-status').textContent = 'Detection failed';
        status.textContent = `Could not detect holds in this image. Add holds manually or choose another photo.${error?.message ? ` (${error.message})` : ''}`;
      } finally {
        detecting = false;
        draw();
      }
    }
    $('photo-detect').addEventListener('click', autoDetectHolds);
    $('photo-undo').addEventListener('click', () => {
      const removed = holds.length - 1;
      holds.pop(); sequence = sequence.filter((index) => index !== removed); if (!sequence.includes(finished)) finished = null; choices.replaceChildren(); draw();
    });
    $('photo-clear').addEventListener('click', () => { holds.length = 0; sequence = []; finished = null; choices.replaceChildren(); draw(); status.textContent = image.hidden ? 'Choose a photo to begin. Your image stays in this browser session.' : 'Annotations cleared. Mark holds on the photo.'; });
    suggest.addEventListener('click', () => {
      if (!sequence.length) return;
      if (!window.ClimbGenPhotoSuggestions?.suggest) {
        choices.textContent = 'The photo suggestion engine did not load. Reload the page and try again.';
        return;
      }
      const suggestionHolds = homography ? holds.map((p) => homography(p) || p) : holds;
      const typedAngle = Number(wallAngle.value);
      const categoryAngle = wallType.value === 'unknown' ? null : Number(wallType.value);
      const wallAngleDeg = wallAngle.value.trim() !== '' && Number.isFinite(typedAngle) ? typedAngle : categoryAngle;
      const result = window.ClimbGenPhotoSuggestions.suggest({ holds: suggestionHolds, sequence, data: dataset, count: 4, normalizedWall: Boolean(homography), wallAngleDeg });
      const candidates = result.suggestions || [];
      choices.replaceChildren();
      if (!candidates.length) { choices.textContent = result.reason || 'No next holds available. Mark more holds or undo a move.'; return; }
      const heading = document.createElement('p'); heading.className = 'photo-choice-label'; heading.textContent = 'PICK A NEXT HOLD'; choices.append(heading);
      candidates.forEach((candidate, rank) => {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'photo-choice';
        const kind = candidate.kind === 'finish' ? 'FINISH OPTION' : `OPTION ${rank + 1}`;
        button.innerHTML = `<span>${kind}</span><b>Hold ${candidate.index + 1}</b><small>${candidate.rationale} · score ${candidate.score}</small>`;
        button.addEventListener('click', () => {
          sequence.push(candidate.index);
          if (candidate.kind === 'finish') finished = candidate.index;
          choices.replaceChildren(); draw();
          status.textContent = finished == null
            ? `Hold ${candidate.index + 1} added. Suggestions now use the end of your current sequence.`
            : `Finish set at hold ${candidate.index + 1}. Remove it from the sequence or choose a new start to continue.`;
        });
        choices.append(button);
      });
      const priorSource = result.prior?.source === 'TB2 community route geometry' ? 'ranked with TB2 route geometry as a movement prior' : 'ranked with the geometric fallback';
      status.textContent = `Ranked ${candidates.length} possible next holds from the last selected contact, ${priorSource}.`;
    });
  }

  function setActiveView(view) {
    $('home-screen').hidden = view !== 'home';
    $('tb2-view').hidden = view !== 'tb2';
    $('photo-view').hidden = view !== 'photo';
    const context = $('context-tag');
    context.hidden = view === 'home';
    context.textContent = view === 'tb2' ? 'TENSION BOARD 2 · 40° MIRROR' : 'PHOTO WALL · LOCAL';
    if (view === 'photo') $('photo-file').focus({ preventScroll: true });
  }

  $('brand-home').addEventListener('click', (event) => { event.preventDefault(); setActiveView('home'); });
  $('home-tb2').addEventListener('click', () => setActiveView('tb2'));
  $('home-photo').addEventListener('click', () => setActiveView('photo'));
  initPhotoBuilder();
  $('tb2-home').addEventListener('click', () => setActiveView('home'));
  $('photo-home').addEventListener('click', () => setActiveView('home'));
  setActiveView('home');
  $('generate-button').addEventListener('click', makeProblem);
  try {
    dataset = window.CLIMBGEN_DATA;
    if (!dataset?.placements?.length || !dataset?.routes?.length) throw new Error('Bundled TB2 data is missing');
    for (const hold of dataset.placements) holdMap.set(String(hold.id), hold);
    ClimbGenHoldSpectrum.apply(holdMap);
    initHoldProfiles();
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
