/* On-demand TB2 route variants seeded from well-rated community climbs. */
(function attach(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ClimbGenRouteGenerator = api;
})(typeof globalThis === 'object' ? globalThis : this, (root) => {
  const roles = { start: 5, hand: 6, finish: 7, foot: 8 };
  const signature = (holds) => holds.map(([id, role]) => `${id}r${role}`).sort().join('|');
  function hash(value) {
    let h = 2166136261;
    for (const ch of String(value)) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function randomFrom(seed) {
    let state = seed || 1;
    return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296; };
  }
  const clamp01 = (value) => Math.min(1, Math.max(0, value));
  const phrases = ['change of direction', 'rising traverse', 'setup and reach'];
  function movementFit(points, phrase) {
    // Work in board coordinates. A mirrored sequence has the same character.
    const moves = points.slice(1).map((point, index) => {
      const dx = point.x - points[index].x, dy = point.y - points[index].y;
      return { dx, dy, length: Math.hypot(dx, dy) };
    });
    let best = 0;
    for (let i = 1; i < moves.length; i++) {
      const a = moves[i - 1], b = moves[i];
      const width = clamp01(Math.min(Math.abs(a.dx), Math.abs(b.dx)) / 16);
      let fit;
      if (phrase === 'change of direction') {
        fit = a.dx * b.dx < 0 ? width : 0;
      } else if (phrase === 'rising traverse') {
        fit = a.dx * b.dx > 0 ? width * clamp01((a.dy + b.dy) / 16) : 0;
      } else {
        // Look for contrasting beats, with a shorter move after the crux.
        const reset = moves[i + 1];
        fit = reset ? clamp01((b.length - a.length) / 14) * clamp01((b.length - reset.length) / 12) : 0;
      }
      best = Math.max(best, fit);
    }
    return best;
  }
  function handLine(holds, placements, plan) {
    const points = (role) => holds.filter(([, r]) => r === role).map(([id]) => placements.get(String(id)));
    const starts = points(roles.start);
    const first = { x: 0, y: 0 };
    for (const p of starts) { first.x += p.x / starts.length; first.y += p.y / starts.length; }
    if (plan) {
      const touched = new Set(holds.filter(([, r]) => r === roles.start).map(([id]) => String(id)));
      const line = [first];
      for (const step of plan.steps || []) {
        const id = String(step.id);
        if (!step.limb?.endsWith('Hand') || touched.has(id) || !placements.has(id)) continue;
        touched.add(id);
        line.push(placements.get(id));
      }
      return line;
    }
    return [first, ...points(roles.hand).sort((a,b) => a.y - b.y || a.x - b.x), ...points(roles.finish)];
  }
  function designTarget(line, pivot, phrase, side, grade) {
    const before = line[pivot - 1], after = line[pivot + 1];
    const mix = phrase === 'setup and reach' ? 0.28 : 0.5;
    const bend = phrase === 'change of direction' ? side * (10 + grade * 0.6) : 0;
    return { x: before.x + (after.x - before.x) * mix + bend, y: before.y + (after.y - before.y) * mix };
  }
  function assess(holds, placements, options = {}) {
    const get = (id) => placements.get(String(id)) || placements.get(id);
    const starts = holds.filter(([, role]) => role === roles.start).map(([id]) => get(id)).filter(Boolean);
    const hands = holds.filter(([, role]) => role === roles.hand).map(([id]) => get(id)).filter(Boolean);
    const finishes = holds.filter(([, role]) => role === roles.finish).map(([id]) => get(id)).filter(Boolean);
    const feet = holds.filter(([, role]) => role === roles.foot).map(([id]) => get(id)).filter(Boolean);
    if (starts.length < 1 || starts.length > 2 || hands.length < 3 || hands.length > 5 || finishes.length !== 1 || !feet.length) return { ok: false, reason: 'hold roles' };
    const allHands = [...starts, ...hands, ...finishes];
    const startY = starts.reduce((n, p) => n + p.y, 0) / starts.length;
    const finishY = finishes[0].y;
    const verticalSpan = Math.max(...allHands.map((p) => p.y)) - Math.min(...allHands.map((p) => p.y));
    const lowMiddleCount = hands.filter((p) => p.y < startY - 10).length;
    const isolatedDistance = Math.max(...hands.map((p) => Math.min(...allHands.filter((q) => q !== p).map((q) => Math.hypot(p.x - q.x, p.y - q.y)))));
    if (starts.some((p) => p.y > (options.maxStartY ?? 44))) return { ok: false, reason: 'start hold too high' };
    if (starts.length > 1 && Math.hypot(starts[0].x - starts[1].x, starts[0].y - starts[1].y) > 40) return { ok: false, reason: 'start holds too far apart' };
    if (finishY - startY < (options.minFinishProgress ?? 24)) return { ok: false, reason: 'finish below route progress' };
    if (verticalSpan < (options.minVerticalSpan ?? 48)) return { ok: false, reason: 'route too compressed vertically' };
    if (lowMiddleCount > 1) return { ok: false, reason: 'too many hands below the start' };
    if (isolatedDistance > (options.maxHoldGap ?? 36)) return { ok: false, reason: 'isolated hand hold' };
    if (!hasProgressingHandSequence(starts, hands, finishes[0], options.maxReach ?? 36)) return { ok: false, reason: 'no upward hand sequence' };
    return { ok: true, features: { finishProgress: finishY - startY, verticalSpan, lowMiddleCount, isolatedDistance } };
  }
  function compactDynoHolds(holds, placements) {
    const starts = holds.filter(([, role]) => role === roles.start);
    const middleHands = holds.filter(([, role]) => role === roles.hand);
    const finishes = holds.filter(([, role]) => role === roles.finish);
    const feet = holds.filter(([, role]) => role === roles.foot);
    if (middleHands.length <= 3 && feet.length <= 2) return holds;

    const startPoints = starts.map(([id]) => placements.get(String(id))).filter(Boolean);
    const startCenter = {
      x: startPoints.reduce((sum, p) => sum + p.x, 0) / Math.max(1, startPoints.length),
      y: startPoints.reduce((sum, p) => sum + p.y, 0) / Math.max(1, startPoints.length),
    };
    const compactFeet = feet.map((hold) => ({ hold, point: placements.get(String(hold[0])) }))
      .filter((item) => item.point)
      .sort((a, b) => Math.hypot(a.point.x - startCenter.x, a.point.y - startCenter.y) - Math.hypot(b.point.x - startCenter.x, b.point.y - startCenter.y))
      .slice(0, 2).map((item) => item.hold);
    const evaluateSubset = (subset) => {
      const candidate = [...starts, ...subset, ...finishes, ...compactFeet];
      if (!assess(candidate, placements).ok) return null;
      const points = subset.map(([id]) => placements.get(String(id))).filter(Boolean);
      let spread = 0;
      for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) {
        spread += Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y);
      }
      return { candidate, spread };
    };
    let best = null;
    const choose = (from, picked) => {
      if (picked.length === 3) {
        const evaluated = evaluateSubset(picked);
        if (evaluated && (!best || evaluated.spread > best.spread)) best = evaluated;
        return;
      }
      for (let i = from; i <= middleHands.length - (3 - picked.length); i++) choose(i + 1, [...picked, middleHands[i]]);
    };
    choose(0, []);
    return best?.candidate || null;
  }
  function hasProgressingHandSequence(starts, hands, finish, maxReach) {
    const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const initialStartY = starts.reduce((n, p) => n + p.y, 0) / starts.length;
    const memo = new Set();
    function visit(left, right, remaining, lastY) {
      if (!remaining.length) return Math.min(distance(left, finish), distance(right, finish)) <= maxReach && finish.y >= initialStartY + 20 && finish.y >= lastY - 20;
      const key = `${left.id},${right.id}|${remaining.map((p) => p.id).sort().join(',')}|${Math.round(lastY / 8)}`;
      if (memo.has(key)) return false;
      memo.add(key);
      for (const target of remaining) {
        if (target.y < lastY - 20) continue;
        const rest = remaining.filter((p) => p !== target);
        if (distance(left, target) <= maxReach && visit(target, right, rest, target.y)) return true;
        if (distance(right, target) <= maxReach && visit(left, target, rest, target.y)) return true;
      }
      return false;
    }
    const left = [...starts].sort((a, b) => a.x - b.x)[0];
    const right = [...starts].sort((a, b) => a.x - b.x).at(-1);
    return visit(left, right, hands, initialStartY);
  }
  function create(data, options = {}) {
    root.ClimbGenHoldSpectrum?.apply(data.placements);
    const placements = new Map(data.placements.map((p) => [String(p.id), p]));
    const evaluatorApi = root.ClimbGenRouteEvaluator || (typeof require === 'function' ? require('./route_evaluator') : null);
    const evaluator = options.evaluator || evaluatorApi?.create?.();
    const frequencyByGrade = new Map();
    const routesByGrade = new Map();
    for (const route of data.routes) {
      if (!/^V(?:[0-9]|10|11)$/.test(route.grade || '') || !Array.isArray(route.holds)) continue;
      if (!routesByGrade.has(route.grade)) routesByGrade.set(route.grade, []);
      if (Number(route.quality || 0) < (options.minCommunityQuality ?? 2.4) || Number(route.ascents || 0) < 3) continue;
      if (!assess(route.holds, placements).ok) continue;
      route.templateKind = 'community';
      routesByGrade.get(route.grade).push(route);
      if (!frequencyByGrade.has(route.grade)) frequencyByGrade.set(route.grade, { 6: new Map(), 8: new Map() });
      const gradeFrequency = frequencyByGrade.get(route.grade);
      for (const [id, role] of route.holds) if (gradeFrequency[role]) gradeFrequency[role].set(String(id), (gradeFrequency[role].get(String(id)) || 0) + 1);
    }
    for (const candidate of data.generated || []) {
      if (candidate.generator !== 'grade-conditional-ddpm' || !/^V(?:[0-9]|10|11)$/.test(candidate.source?.grade || '') || !assess(candidate.holds, placements).ok) continue;
      if (!routesByGrade.has(candidate.source.grade)) routesByGrade.set(candidate.source.grade, []);
      routesByGrade.get(candidate.source.grade).push({ id: `ddpm-${signature(candidate.holds).slice(0, 12)}`, grade: candidate.source.grade, holds: candidate.holds, quality: 2.4, ascents: 3, templateKind: 'ddpm' });
    }
    const grades = [...routesByGrade.keys()].filter((grade) => /^V(?:[0-9]|10|11)$/.test(grade) && routesByGrade.get(grade).length).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
    if (!grades.length) throw new Error('No quality-checked TB2 community templates are available');
    for (const grade of grades) routesByGrade.get(grade).sort((a, b) => Number(b.quality || 0) - Number(a.quality || 0) || Number(b.ascents || 0) - Number(a.ascents || 0));
    const sourceSignatures = new Set([...data.routes, ...(data.generated || [])].filter(r => Array.isArray(r.holds)).map(r => signature(r.holds)));
    const seen = new Set(), recentHands = [];
    const salt = options.salt ?? `${Date.now()}-${Math.random()}`;
    const weightedPick = (items, weight, rng) => {
      const weights = items.map((item) => Math.max(0.0001, weight(item)));
      let n = rng() * weights.reduce((a, b) => a + b, 0);
      for (let i = 0; i < items.length; i++) { n -= weights[i]; if (n <= 0) return items[i]; }
      return items.at(-1);
    };
    function styleFit(betaPlan, style) {
      if (!style || style === 'any') return 0;
      const handMoves = (betaPlan?.steps || []).filter((step) => step.limb?.endsWith('Hand') && (step.role === roles.hand || step.role === roles.finish))
        .map((step) => Number(step.movementDistance)).filter(Number.isFinite);
      if (!handMoves.length) return 0;
      const meanDistance = handMoves.reduce((sum, distance) => sum + distance, 0) / handMoves.length;
      const longMoveShare = handMoves.filter((distance) => distance >= 22).length / handMoves.length;
      const reach = Math.max(0, Math.min(1, meanDistance / 38));
      return style === 'dynamic'
        ? 0.55 * reach + 0.45 * longMoveShare
        : 1 - (0.55 * reach + 0.45 * longMoveShare);
    }
    function choosePhrase(style, rng) {
      if (style === 'dynamic' && rng() < 0.65) return 'setup and reach';
      if (style === 'static' && rng() < 0.65) return phrases[Math.floor(rng() * 2)];
      return phrases[Math.floor(rng() * phrases.length)];
    }
    function generate({ grade = 'any', name = '', sequence = 0, style = 'any', movementIntent } = {}) {
      const seed = hash(`${salt}|${name}|${grade}|${style}|${sequence}`);
      const rng = randomFrom(seed);
      const chosenGrade = grade === 'any' ? grades[Math.floor(rng() * grades.length)] : grade;
      const templates = routesByGrade.get(chosenGrade) || [];
      if (!templates.length) throw new Error(`No quality-checked TB2 templates for ${chosenGrade}`);
      const gradeFrequency = frequencyByGrade.get(chosenGrade) || { 6: new Map(), 8: new Map() };
      const phrase = movementIntent || choosePhrase(style, rng);
      const rankAttempts = Math.max(1, Math.floor(options.rankAttempts ?? 12));
      const ranked = [];
      const rankedSignatures = new Set();
      const community = templates.filter((r) => r.templateKind !== 'ddpm');
      const communityTemplates = community.slice(0, Math.max(30, Math.ceil(community.length * 0.75)));
      const modelTemplates = templates.filter((r) => r.templateKind === 'ddpm');
      for (let attempt = 0; attempt < (options.attempts ?? 900); attempt++) {
        const useModelSeed = modelTemplates.length > 0 && (communityTemplates.length === 0 || rng() < (options.diffusionSeedRate ?? 0.7));
        const seedPool = useModelSeed ? modelTemplates : communityTemplates;
        const template = weightedPick(seedPool, (r) => (Number(r.quality || 2.4) + 0.25) ** 2 * Math.log2(Number(r.ascents || 3) + 2), rng);
        const holds = template.holds.map(([id, role]) => [Number(id), Number(role)]);
        const mutable = holds.map((pair, index) => ({ pair, index })).filter(({ pair }) => pair[1] === roles.hand || pair[1] === roles.foot);
        if (!mutable.length) continue;
        // Shape an interior hand move first, then vary the holds around it.
        const line = handLine(holds, placements);
        const pivot = 1 + Math.floor(rng() * (line.length - 2));
        const anchor = line[pivot];
        const target = designTarget(line, pivot, phrase, rng() < 0.5 ? -1 : 1, Number(chosenGrade.slice(1)));
        const changeRoll = rng();
        const changeCount = changeRoll < 0.2 ? 1 : changeRoll < 0.72 ? 2 : 3;
        const chosen = [mutable.find(({pair}) => String(pair[0]) === String(anchor.id))];
        while (chosen.length < Math.min(changeCount, mutable.length)) {
          const item = mutable[Math.floor(rng() * mutable.length)];
          if (!chosen.some((x) => x.index === item.index)) chosen.push(item);
        }
        const used = new Set(holds.map(([id]) => String(id)));
        let changed = 0;
        for (const { pair, index } of chosen) {
          const old = placements.get(String(pair[0]));
          const role = pair[1];
          const candidates = [...(gradeFrequency[role] || new Map()).entries()].map(([id, count]) => {
            const p = placements.get(id);
            const d = p ? Math.hypot(p.x - old.x, p.y - old.y) : Infinity;
            return { id: Number(id), count, d, p };
          }).filter((c) => c.p && !used.has(String(c.id)) && c.d >= 4 && c.d <= 25);
          if (!candidates.length) continue;
          const oldTier = old.difficulty?.handTier;
          const replacement = weightedPick(candidates, (c) => {
            const newTier = c.p.difficulty?.handTier;
            const fit = role === roles.hand && Number.isInteger(oldTier) && Number.isInteger(newTier) ? Math.exp(-0.35 * Math.abs(newTier - oldTier)) : 1;
            let intentFit = 1;
            if (old === anchor) {
              intentFit = Math.exp(-Math.hypot(c.p.x - target.x, c.p.y - target.y) / 10);
            } else if (role === roles.foot && Math.hypot(old.x - target.x, old.y - target.y + 24) <= 26) {
              // Give the setter a foothold near the setup for this move.
              intentFit = Math.exp(-Math.hypot(c.p.x - target.x, c.p.y - target.y + 24) / 22);
            }
            return intentFit * fit * Math.sqrt(c.count) / (1 + c.d / 18);
          }, rng);
          used.delete(String(pair[0]));
          used.add(String(replacement.id));
          holds[index] = [replacement.id, role];
          changed++;
        }
        if (!changed) continue;
        const generatedHolds = style === 'dynamic' ? compactDynoHolds(holds, placements) : holds;
        if (!generatedHolds) continue;
        const key = signature(generatedHolds);
        if (sourceSignatures.has(key) || seen.has(key) || rankedSignatures.has(key) || !assess(generatedHolds, placements).ok) continue;
        rankedSignatures.add(key);
        const evaluation = evaluator?.score(generatedHolds, placements, chosenGrade) || null;
        const middleIds = generatedHolds.filter(([, r]) => r === roles.hand).map(([id]) => id);
        const repeat = Math.max(0, ...recentHands.map(last => middleIds.filter(id => last.has(id)).length / middleIds.length));
        const fit = movementFit(handLine(generatedHolds, placements), phrase);
        const setterScore = (evaluation?.rankScore ?? 0) + 0.65 * fit - 0.4 * repeat;
        ranked.push({ holds: generatedHolds, grade: chosenGrade, source: { grade: chosenGrade, style, movementIntent: phrase, templateId: template.id, templateKind: template.templateKind || 'community', quality: Number(template.quality || 0), gradeConditioned: true }, changed, signature: key, generatedOnDemand: true, evaluation, setterScore });
        if (ranked.length >= rankAttempts) break;
      }
      if (ranked.length) {
        ranked.sort((a, b) => b.setterScore - a.setterScore);
        const chosen = ranked[0];
        seen.add(chosen.signature);
        recentHands.push(new Set(chosen.holds.filter(([, r]) => r === roles.hand).map(([id]) => id)));
        if (recentHands.length > 8) recentHands.shift();
        return chosen;
      }
      throw new Error(`Could not find a new quality-checked ${chosenGrade} variant after ${options.attempts ?? 900} attempts. Generate again.`);
    }
    async function generatePlayable(request, validate, config = {}) {
      const checks = config.maxChecks ?? 6;
      const style = request.style || 'any';
      const rng = randomFrom(hash(`${salt}|${request.name}|${request.grade}|${style}|${request.sequence}|phrase`));
      const movementIntent = choosePhrase(style, rng);
      const grade = !request.grade || request.grade === 'any' ? grades[Math.floor(rng() * grades.length)] : request.grade;
      let best = null, playableCount = 0;
      for (let attempt = 0; attempt < checks; attempt++) {
        const candidate = generate({ ...request, grade, movementIntent, sequence: Number(request.sequence || 0) * checks + attempt });
        config.onProgress?.(attempt + 1, checks);
        const betaPlan = await validate(candidate, attempt);
        if (betaPlan?.ok) {
          const actualFit = movementFit(handLine(candidate.holds, placements, betaPlan), movementIntent);
          const result = { ...candidate, betaPlan, checksPerformed: attempt + 1, movementFit: actualFit, styleFit: styleFit(betaPlan, style) };
          playableCount++;
          const playableScore = r => (r.evaluation?.rankScore ?? 0) + 0.8 * r.movementFit + r.styleFit;
          if (!best || playableScore(result) > playableScore(best)) best = result;
          if (actualFit >= 0.8 && style === 'any') break;
          if (playableCount >= (config.styleCandidates ?? 3)) break;
        }
      }
      if (best) return best;
      throw new Error(`Could not find a beta-plannable variant after ${checks} quality-checked attempts. Generate again.`);
    }
    return { generate, generatePlayable, grades, countGenerated: () => seen.size, assess: (holds) => assess(holds, placements) };
  }
  return { create, assess, signature, movementFit };
});
