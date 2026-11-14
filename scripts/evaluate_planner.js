const fs = require('node:fs');
const vm = require('node:vm');
const Planner = require('../planner');
const IK = require('../ik');
const context = { window: {} };
vm.runInNewContext(fs.readFileSync(require.resolve('../data/tb2-mirror-40.js'), 'utf8'), context);
const data = context.window.CLIMBGEN_DATA;
const placements = new Map(data.placements.map((p) => [String(p.id), p]));

// Fixed stratified indices cover V0–V11 while producing a repeatable corpus.
const indices = [...Array(12)].map((_, grade) => grade * 10 + (grade % 3));
const rows = [];
for (const index of indices) {
  const candidate = data.generated[index];
  const problem = { holds: candidate.holds.map(([id, role]) => ({ id, role })) };
  const startHolds = problem.holds.filter((h) => h.role === 5).sort((a, b) => placements.get(String(a.id)).x - placements.get(String(b.id)).x);
  const oldSteps = candidate.plan || [];
  let oldReachViolations = 0;
  const previousHands = {
    'L hand': startHolds.length ? placements.get(String(startHolds[0].id)) : { x: 0, y: 0 },
    'R hand': startHolds.length ? placements.get(String(startHolds.at(-1).id)) : { x: 0, y: 0 },
  };
  for (const step of oldSteps) {
    const target = placements.get(String(step.id));
    if (!target) continue;
    // Existing behavior executed the precomputed hand list without solving
    // support or feet; this records its simple 2D hand reach excursions.
    const limb = step.limb === 'L hand' ? 'L hand' : 'R hand';
    if (Math.hypot(target.x - previousHands[limb].x, target.y - previousHands[limb].y) > 36) oldReachViolations++;
    previousHands[limb] = target;
  }
  const began = performance.now();
  const result = Planner.plan(problem, placements, { maxExpanded: 500, beamWidth: 30, maxDepth: 24 });
  const elapsedMs = performance.now() - began;
  rows.push({ index, grade: candidate.source.grade, routeHolds: candidate.holds.length, baselineMoves: oldSteps.length, baselineHandReachExcursions: oldReachViolations, plannerFound: result.ok, plannerMoves: result.steps?.length ?? null, footMoves: result.steps?.filter((s) => s.limb.endsWith('Foot')).length ?? null, plannerMaxReachViolation: result.diagnostics?.maxReachViolation ?? null, estimatedSupportCost: result.diagnostics?.maxEstimatedStabilityCost ?? null, expanded: result.expanded, elapsedMs: Number(elapsedMs.toFixed(1)), failure: result.reason ?? null });
}
console.log(JSON.stringify({ description: 'Deterministic stratified beta-planner evaluation; heuristic diagnostics, not ground-truth beta labels.', indices, found: rows.filter((r) => r.plannerFound).length, total: rows.length, rows }, null, 2));
