const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const IK = require('../ik');
const Planner = require('../planner');
const RouteGenerator = require('../route_generator');

function loadData() {
  const context = { window: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../data/tb2-mirror-40.js'), 'utf8'), context);
  const data = context.window.CLIMBGEN_DATA;
  return { data, placements: new Map(data.placements.map((p) => [String(p.id), p])) };
}

test('IK preserves reachable contact anchors and segment lengths', () => {
  const placements = new Map([
    ['lh', { id: 'lh', x: -15, y: 28 }], ['rh', { id: 'rh', x: 15, y: 28 }],
    ['lf', { id: 'lf', x: -10, y: 0 }], ['rf', { id: 'rf', x: 10, y: 0 }],
  ]);
  const pose = IK.solve({ leftHand: 'lh', rightHand: 'rh', leftFoot: 'lf', rightFoot: 'rf' }, placements);
  assert.ok(pose.diagnostics.maxReachViolation < 0.01);
  assert.ok(pose.diagnostics.maxSegmentResidual < 0.01);
  for (const limb of Object.keys(IK.LIMBS)) {
    const target = placements.get(limb === 'leftHand' ? 'lh' : limb === 'rightHand' ? 'rh' : limb === 'leftFoot' ? 'lf' : 'rf');
    assert.ok(Math.hypot(pose.points[limb].x - target.x, pose.points[limb].y - target.y) < 1e-9);
  }
});

test('planner is deterministic on a bundled TB2 community route', () => {
  const { data, placements } = loadData();
  const candidate = data.generated[0];
  const problem = { holds: candidate.holds.map(([id, role]) => ({ id, role })) };
  const options = { maxExpanded: 500, beamWidth: 30, maxDepth: 24 };
  const a = Planner.plan(problem, placements, options);
  const b = Planner.plan(problem, placements, options);
  assert.equal(a.ok, true, a.reason);
  assert.deepEqual(a.steps.map((s) => [s.limb, s.id]), b.steps.map((s) => [s.limb, s.id]));
  assert.ok(a.initialContacts.leftHand && a.initialContacts.rightHand && a.initialContacts.leftFoot && a.initialContacts.rightFoot);
  assert.ok(a.steps.every((step) => step.pose?.points && step.contacts?.[step.limb] === String(step.id)));
  assert.ok(a.expanded <= options.maxExpanded);
  assert.ok(a.steps.some((s) => s.limb.endsWith('Foot')));
});

test('planner reports impossible route instead of substituting candidate plan', () => {
  const placements = new Map([
    ['s', { id: 's', x: 0, y: 4 }], ['h', { id: 'h', x: 0, y: 18 }], ['f', { id: 'f', x: 60, y: 140 }],
  ]);
  const result = Planner.plan({ holds: [{ id: 's', role: 5 }, { id: 'h', role: 6 }, { id: 'f', role: 7 }], plan: [{ id: 'f', limb: 'R hand', role: 7 }] }, placements, { maxExpanded: 80, beamWidth: 12 });
  assert.equal(result.ok, false);
  assert.match(result.reason, /No contact sequence/);
  assert.equal(result.steps, undefined);
});

test('on-demand generator produces fresh quality-checked variants beyond the bundled pool', () => {
  const { data, placements } = loadData();
  const generator = RouteGenerator.create(data, { salt: 'route-generator-regression' });
  const signatures = new Set();
  for (let sequence = 0; sequence < 100; sequence++) {
    const route = generator.generate({ grade: 'V5', name: 'Long Run', sequence });
    assert.equal(route.source.grade, 'V5');
    assert.ok(route.changed > 0);
    assert.ok(RouteGenerator.assess(route.holds, placements).ok);
    for (const [id, role] of route.holds) if (role === 5) assert.ok(placements.get(String(id)).y <= 44, 'start must be in the lower third of the board');
    assert.ok(!signatures.has(route.signature), `Repeated variant at ${sequence}`);
    signatures.add(route.signature);
  }
  assert.equal(generator.countGenerated(), 100);
});

test('one generated variant per selectable grade has low starts and a beta plan', async () => {
  const { data, placements } = loadData();
  const generator = RouteGenerator.create(data, { salt: 'grade-feasibility-regression' });
  for (let grade = 0; grade <= 11; grade++) {
    const route = await generator.generatePlayable(
      { grade: `V${grade}`, name: 'Grade check', sequence: grade },
      (candidate) => Planner.planAsync({ holds: candidate.holds.map(([id, role]) => ({ id, role })) }, placements, { maxExpanded: 500, beamWidth: 24, maxDepth: 24 }),
      { maxChecks: 8 },
    );
    assert.ok(route.holds.filter(([, role]) => role === 5).every(([id]) => placements.get(String(id)).y <= 44));
    assert.equal(route.betaPlan.ok, true, `V${grade}`);
    assert.ok(route.checksPerformed >= 1 && route.checksPerformed <= 8);
  }
});
