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
    const seen = new Set();
    const salt = options.salt ?? `${Date.now()}-${Math.random()}`;
    const weightedPick = (items, weight, rng) => {
      const weights = items.map((item) => Math.max(0.0001, weight(item)));
      let n = rng() * weights.reduce((a, b) => a + b, 0);
      for (let i = 0; i < items.length; i++) { n -= weights[i]; if (n <= 0) return items[i]; }
      return items.at(-1);
    };
    function generate({ grade = 'any', name = '', sequence = 0 } = {}) {
      const seed = hash(`${salt}|${name}|${grade}|${sequence}`);
      const rng = randomFrom(seed);
      const chosenGrade = grade === 'any' ? grades[Math.floor(rng() * grades.length)] : grade;
      const templates = routesByGrade.get(chosenGrade) || [];
      if (!templates.length) throw new Error(`No quality-checked TB2 templates for ${chosenGrade}`);
      const gradeFrequency = frequencyByGrade.get(chosenGrade) || { 6: new Map(), 8: new Map() };
      // Rank a small pool of screened variants when the learned evaluator is
      // available. Without a trained model, retain the original first-valid
      // behavior so generation remains usable in offline/dev builds.
      const rankAttempts = evaluator ? Math.max(1, Math.floor(options.rankAttempts ?? 10)) : 1;
      const ranked = [];
      const rankedSignatures = new Set();
      // Try many local variants before moving to another highly-rated template.
      for (let attempt = 0; attempt < (options.attempts ?? 900); attempt++) {
        const communityTemplates = templates.filter((r) => r.templateKind !== 'ddpm').slice(0, Math.max(30, Math.ceil(templates.filter((r) => r.templateKind !== 'ddpm').length * 0.75)));
        const modelTemplates = templates.filter((r) => r.templateKind === 'ddpm');
        const useModelSeed = modelTemplates.length > 0 && (communityTemplates.length === 0 || rng() < (options.diffusionSeedRate ?? 0.7));
        const seedPool = useModelSeed ? modelTemplates : communityTemplates;
        const template = weightedPick(seedPool, (r) => (Number(r.quality || 2.4) + 0.25) ** 2 * Math.log2(Number(r.ascents || 3) + 2), rng);
        const holds = template.holds.map(([id, role]) => [Number(id), Number(role)]);
        const mutable = holds.map((pair, index) => ({ pair, index })).filter(({ pair }) => pair[1] === roles.hand || pair[1] === roles.foot);
        if (!mutable.length) continue;
        // Change several contacts so successive variants don't feel like the
        // same community route with a single hold swapped. Keep a meaningful
        // share of one-contact edits for grades where the planner has fewer
        // feasible alternatives.
        const changeRoll = rng();
        const changeCount = changeRoll < 0.2 ? 1 : changeRoll < 0.72 ? 2 : 3;
        const chosen = [];
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
          const replacement = weightedPick(candidates, (c) => Math.sqrt(c.count) / (1 + c.d / 18), rng);
          used.delete(String(pair[0]));
          used.add(String(replacement.id));
          holds[index] = [replacement.id, role];
          changed++;
        }
        if (!changed) continue;
        const key = signature(holds);
        if (seen.has(key) || rankedSignatures.has(key) || !assess(holds, placements).ok) continue;
        rankedSignatures.add(key);
        const evaluation = evaluator?.score(holds, placements, chosenGrade) || null;
        ranked.push({ holds, grade: chosenGrade, source: { grade: chosenGrade, templateId: template.id, templateKind: template.templateKind || 'community', quality: Number(template.quality || 0), gradeConditioned: true }, changed, signature: key, generatedOnDemand: true, evaluation });
        if (ranked.length >= rankAttempts) break;
      }
      if (ranked.length) {
        ranked.sort((a, b) => (b.evaluation?.rankScore ?? 0) - (a.evaluation?.rankScore ?? 0));
        const chosen = ranked[0];
        seen.add(chosen.signature);
        return chosen;
      }
      throw new Error(`Could not find a new quality-checked ${chosenGrade} variant after ${options.attempts ?? 900} attempts. Generate again.`);
    }
    async function generatePlayable(request, validate, config = {}) {
      const checks = config.maxChecks ?? 6;
      for (let attempt = 0; attempt < checks; attempt++) {
        const candidate = generate({ ...request, sequence: Number(request.sequence || 0) * checks + attempt });
        config.onProgress?.(attempt + 1, checks);
        const betaPlan = await validate(candidate, attempt);
        if (betaPlan?.ok) return { ...candidate, betaPlan, checksPerformed: attempt + 1 };
      }
      throw new Error(`Could not find a beta-plannable variant after ${checks} quality-checked attempts. Generate again.`);
    }
    return { generate, generatePlayable, grades, countGenerated: () => seen.size, assess: (holds) => assess(holds, placements) };
  }
  return { create, assess, signature };
});
