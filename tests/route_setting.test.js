const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Generator = require('../route_generator');

test('movement phrases distinguish a turn, a traverse and a reach with a recovery', () => {
  const line = coordinates => coordinates.map(([x, y]) => ({ x, y }));
  const turn = line([[0, 8], [16, 18], [0, 30], [2, 42]]);
  const traverse = line([[0, 8], [16, 16], [32, 28], [32, 36]]);
  const reach = line([[0, 8], [0, 16], [0, 48], [0, 56]]);
  const ladder = line([[0, 8], [0, 24], [0, 40], [0, 56]]);
  for (const [phrase, points] of [['change of direction', turn], ['rising traverse', traverse], ['setup and reach', reach]]) {
    assert.equal(Generator.movementFit(points, phrase), 1);
    assert.equal(Generator.movementFit(points.map(p => ({ x: -p.x, y: p.y })), phrase), 1);
    assert.equal(Generator.movementFit(ladder, phrase), 0);
  }
});

test('generated problems are new and keep a single setting intent and grade through planner retries', async () => {
  const context = { window: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../data/tb2-mirror-40.js'), 'utf8'), context);
  const data = context.window.CLIMBGEN_DATA;
  const generator = Generator.create(data, { salt: 'routesetter-fixture' });
  const library = new Set([...data.routes, ...data.generated].map(route => Generator.signature(route.holds)));
  const requests = [];
  const route = await generator.generatePlayable({ grade: 'any', name: 'Pivot', style: 'dynamic' }, (candidate, attempt) => {
    requests.push(candidate.source);
    assert.ok(!library.has(candidate.signature));
    assert.ok(candidate.holds.filter(([, role]) => role === 6).length <= 3);
    assert.ok(candidate.holds.filter(([, role]) => role === 8).length <= 2);
    return { ok: attempt > 0, steps: [] };
  }, { maxChecks: 3, styleCandidates: 2 });
  assert.equal(requests.length, 3);
  assert.equal(new Set(requests.map(r => r.grade)).size, 1);
  assert.equal(new Set(requests.map(r => r.movementIntent)).size, 1);
  assert.equal(route.movementFit, 0);
});
