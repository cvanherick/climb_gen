const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Profiles = require('../hold_profiles');
const IK = require('../ik');
function load() {
  const context = { window: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../data/tb2-mirror-40.js'), 'utf8'), context);
  vm.runInNewContext(fs.readFileSync(require.resolve('../data/tb2-hold-profiles.js'), 'utf8'), context);
  return { placements: context.window.CLIMBGEN_DATA.placements, profiles: context.CLIMBGEN_HOLD_PROFILES };
}
test('all 498 crop IDs join real board coordinates and image-y directions convert to board-y', () => {
  const { placements, profiles } = load();
  assert.equal(Profiles.apply(placements, profiles), 498);
  assert.equal(placements.find(p => p.id === 307).profile.pull.y, -0.997);
  assert.equal(new Set(placements.map(p => p.profile.atlasIndex)).size, 498);
  assert.ok(fs.existsSync(require.resolve('../assets/tb2-hold-crops-atlas.webp')));
  const reviewed = Profiles.parseAnnotations({ layout_id: 10, reviewed_annotations: { 307: { dx: 1, dy: 1, unknown: false, verified: true } } }, profiles);
  Profiles.apply(placements, profiles, reviewed);
  const p = placements.find(p => p.id === 307).profile;
  assert.ok(p.verified && p.pull.x > 0 && p.pull.y < 0);
  assert.throws(() => Profiles.parseAnnotations({ layout_id: 99, reviewed_annotations: {} }, profiles));
  assert.throws(() => Profiles.parseAnnotations({ layout_id: 10, reviewed_annotations: { 999: {} } }, profiles));
});
test('direction costs allow body-position variation, distinguish opposing pulls and ignore unknowns', () => {
  const target = { x: 0, y: 0, profile: { pull: { x: 0, y: -1 }, verified: true } };
  assert.equal(IK.directionPenalty(target, { x: 0, y: -20 }).cost, 0);
  assert.equal(IK.directionPenalty(target, { x: 10, y: -20 }).cost, 0);
  assert.ok(IK.directionPenalty(target, { x: 0, y: 20 }).cost > 0.9);
  target.profile.verified = false;
  assert.ok(IK.directionPenalty(target, { x: 0, y: 20 }).cost < 0.1);
  target.profile.unknown = true;
  assert.equal(IK.directionPenalty(target, { x: 0, y: 20 }).cost, 0);
});
test('hands, fingers, ankles and independent pelvis rotation preserve actual limb lengths and anchors', () => {
  const map = new Map([['lh', {x:-15,y:28}], ['rh',{x:15,y:28}], ['lf',{x:-10,y:0}], ['rf',{x:10,y:0}]]);
  const contacts = { leftHand:'lh',rightHand:'rh',leftFoot:'lf',rightFoot:'rf' };
  const pose = IK.solve(contacts, map);
  assert.ok(Number.isFinite(pose.torso.hipTheta));
  for (const side of ['left', 'right']) {
    assert.equal(pose.hands[side].fingers.length, 5);
    assert.ok(pose.hands[side].fingers.every(chain => chain.length === 4));
    const p = pose.points;
    const distance = (a, b) => Math.hypot(a.x-b.x,a.y-b.y);
    assert.ok(Math.abs(distance(p[side+'Elbow'], p[side+'Wrist']) - IK.DEFAULT_BODY.lowerArm) < 0.01);
    assert.ok(Math.abs(distance(p[side+'Knee'], p[side+'Ankle']) - IK.DEFAULT_BODY.lowerLeg) < 0.01);
    assert.deepEqual(p[side+'Foot'], map.get(contacts[side+'Foot']));
  }
});
test('planner consumes annotated placements and retains four contact endpoints', () => {
  const Planner = require('../planner');
  const { placements, profiles } = load();
  Profiles.apply(placements, profiles);
  const map = new Map(placements.map(p => [String(p.id),p]));
  const context = {window:{}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../data/tb2-mirror-40.js'), 'utf8'),context);
  const candidate = context.window.CLIMBGEN_DATA.generated[0];
  const plan = Planner.plan({holds:candidate.holds.map(([id,role])=>({id,role}))},map,{maxExpanded:500,beamWidth:30,maxDepth:24});
  assert.equal(plan.ok,true,plan.reason);
  for (const step of plan.steps) {
    assert.ok(Number.isFinite(step.diagnostics.holdDirectionCost));
    for (const [limb,id] of Object.entries(step.contacts)) {
      const contact=map.get(id);
      assert.ok(Math.hypot(step.pose.points[limb].x-contact.x,step.pose.points[limb].y-contact.y)<1e-9);
    }
    assert.ok(step.diagnostics.maxSegmentResidual<0.25);
  }
});
