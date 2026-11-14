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
  let dataset, generatedCount = 0, animationTimer, generating = false;

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
  function drawBoard(route = null, activeStep = -1) {
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
  function sampleProblem() {
    // Candidate generation and reach checking happen at build time. Keeping the
    // click path to a single array lookup avoids a long-running planner freezing
    // the page or leaving the Generate button stuck in its busy state.
    const pool = dataset.generated;
    if (!Array.isArray(pool) || pool.length === 0) throw new Error('No prepared TB2 problems are bundled');
    const candidate = pool[Math.floor(Math.random() * pool.length)];
    if (!Array.isArray(candidate.holds) || !Array.isArray(candidate.plan)) throw new Error('Prepared TB2 problem is invalid');
    return {
      holds: routeHolds(candidate),
      plan: candidate.plan,
      source: candidate.source,
      changed: candidate.changed,
    };
  }
  function renderResult(problem) {
    generatedCount++;
    $('route-title').textContent = `Problem ${String(generatedCount).padStart(2, '0')}`;
    $('route-grade').textContent = `40° · ≈${problem.source.grade}`;
    $('route-copy').textContent = `${problem.holds.length} holds · ${problem.plan.length} moves`;
    $('hold-count').textContent = problem.holds.length;
    $('move-count').textContent = problem.plan.length;
    $('data-count').textContent = dataset.filtered_routes.toLocaleString();
    $('beta-status').textContent = 'REACH CHECKED';
    $('board-status').textContent = problem.changed ? 'GENERATED' : 'COMMUNITY ROUTE';
    $('board-status').classList.add('ready');
    $('board-hint').classList.add('hidden');
    const list = $('sequence-list');
    list.replaceChildren();
    problem.plan.forEach((step, i) => list.append(sequenceItem(i + 1, step.id, step.limb, step.role === 7 ? 'finish' : 'hand')));
    drawBoard(problem, -1);
    animatePlan(problem);
  }
  function sequenceItem(number, id, label, role) {
    const li = document.createElement('li');
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
