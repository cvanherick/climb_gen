const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const Planner = require('../planner');
const Animation = require('../animation');
function fixture() {
  const context = { window: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../data/tb2-mirror-40.js'), 'utf8'), context);
  const data = context.window.CLIMBGEN_DATA;
  const placements = new Map(data.placements.map(p => [String(p.id), p]));
  const plan = Planner.plan({ holds: data.generated[0].holds.map(([id, role]) => ({ id, role })) }, placements, { maxExpanded: 500, beamWidth: 30, maxDepth: 24 });
  assert.ok(plan.ok, plan.reason);
  return { timeline: Animation.create(plan, placements), plan, placements };
}
test('sampled playback retains planted anchors, stable bend directions and fixed limb lengths without joint spikes', () => {
  const { timeline, plan, placements } = fixture();
  let previous = null;
  let maxJointStep = 0;
  for (let t = 0; t < timeline.duration; t += 1000 / 60) {
    const frame = timeline.sample(t), pose = frame.pose, segment = timeline.segments[frame.stepIndex];
    for (const limb of Object.keys(segment.contacts)) {
      if (limb === segment.step.limb) continue;
      const expected = placements.get(segment.contacts[limb]);
      assert.ok(Math.hypot(pose.points[limb].x - expected.x, pose.points[limb].y - expected.y) < 1e-9, `contact drift: ${limb}`);
    }
    assert.deepEqual(pose.bendDirections, plan.initialPose.bendDirections);
    assert.ok(pose.diagnostics.maxSegmentResidual < 0.01);
    if (previous) for (const key of Object.keys(pose.points)) {
      const a = pose.points[key], b = previous.points[key];
      maxJointStep = Math.max(maxJointStep, Math.hypot(a.x - b.x, a.y - b.y));
    }
    previous = pose;
  }
  assert.ok(maxJointStep < 0.9, `joint jump at 60fps: ${maxJointStep}`);
  for (const segment of timeline.segments.slice(1)) {
    const a = timeline.sample(segment.start - 0.01).pose;
    const b = timeline.sample(segment.start + 0.01).pose;
    for (const key of Object.keys(a.points)) assert.ok(Math.hypot(a.points[key].x - b.points[key].x, a.points[key].y - b.points[key].y) < 0.01, `move boundary snap: ${key}`);
  }
  const last = timeline.sample(timeline.duration);
  assert.ok(last.done);
  for (const [limb, id] of Object.entries(plan.finalContacts)) {
    const expected = placements.get(id);
    assert.ok(Math.hypot(last.pose.points[limb].x - expected.x, last.pose.points[limb].y - expected.y) < 1e-9);
  }
  assert.deepEqual(timeline.sample(350).pose, timeline.sample(350).pose, 'seeking is deterministic');
});
test('pause, speed changes and background delays preserve playback time', () => {
  const clock = Animation.clock();
  clock.tick(0); clock.tick(50);
  assert.equal(clock.elapsed, 50);
  clock.pause();
  assert.equal(clock.tick(5000), 50, 'resume must retain the current move position');
  assert.equal(clock.tick(5050, 0.7), 85);
  assert.equal(clock.tick(5100, 1.4), 155);
  assert.equal(clock.tick(20000), 255, 'background tabs must not jump ahead seconds');
});
