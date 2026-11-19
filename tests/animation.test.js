const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const Planner = require('../planner');
const Animation = require('../animation');
const IK = require('../ik');
const Board = require('../board_3d');
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
    const pelvis = Board.toWorld([pose.torso.x, pose.torso.y, pose.depth.pelvis]);
    assert.ok(pelvis[1] >= 4.499);
    assert.ok(pose.diagnostics.footClearance>=IK.FOOT_BELOW_HEAD-1e-6);
    const height=key=>Board.toWorld([pose.points[key].x,pose.points[key].y,pose.depth[key]])[1];
    for(const part of ['leftFoot','rightFoot','leftHeel','rightHeel','leftAnkle','rightAnkle']) {
      assert.ok(height('head')-height(part)>=IK.FOOT_BELOW_HEAD-1e-6);
    }
    for (const limb of Object.keys(segment.contacts)) {
      if (limb === segment.step.limb) continue;
      const expected = placements.get(segment.contacts[limb]);
      assert.ok(Math.hypot(pose.points[limb].x - expected.x, pose.points[limb].y - expected.y) < 1e-9, `contact drift: ${limb}`);
      assert.equal(pose.depth[limb], 0, `planted contact lifted: ${limb}`);
    }
    assert.deepEqual(pose.bendDirections, plan.initialPose.bendDirections);
    assert.ok(pose.diagnostics.maxSegmentResidual < 0.01);
    const length = (a, b) => Math.hypot(pose.points[b].x - pose.points[a].x,
      pose.points[b].y - pose.points[a].y, pose.depth[b] - pose.depth[a]);
    for (const side of ['left', 'right']) {
      assert.ok(Math.abs(length(side + 'Shoulder', side + 'Elbow') - IK.DEFAULT_BODY.upperArm) < 0.01);
      assert.ok(Math.abs(length(side + 'Elbow', side + 'Wrist') - IK.DEFAULT_BODY.lowerArm) < 0.01);
      assert.ok(Math.abs(length(side + 'Hip', side + 'Knee') - IK.DEFAULT_BODY.upperLeg) < 0.01);
      assert.ok(Math.abs(length(side + 'Knee', side + 'Ankle') - IK.DEFAULT_BODY.lowerLeg) < 0.01);
      assert.ok(Math.abs(length(side + 'Foot', side + 'Heel') - IK.DEFAULT_BODY.footLength) < 0.01);
    }
    assert.ok(Math.abs(length('leftShoulder', 'rightShoulder') - IK.DEFAULT_BODY.shoulderWidth) < 0.01);
    if (previous) for (const key of Object.keys(pose.points)) {
      const a = pose.points[key], b = previous.points[key];
      maxJointStep = Math.max(maxJointStep, Math.hypot(a.x - b.x, a.y - b.y,
        (pose.depth[key] || 0) - (previous.depth[key] || 0)));
    }
    previous = pose;
  }
  assert.ok(maxJointStep < 1.55, `joint jump at 60fps: ${maxJointStep}`);
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

test('a hand reach loads a shoe before release, and a foot lifts between raised hold surfaces', () => {
  const wall = {
    lh: { x: -14, y: 75 }, rh: { x: 12, y: 74 }, lf: { x: -12, y: 10 },
    rf: { x: 13, y: 12 }, nextHand: { x: 21, y: 82 }, nextFoot: { x: -5, y: 23 },
  };
  const initial = { leftHand: 'lh', rightHand: 'rh', leftFoot: 'lf', rightFoot: 'rf' };
  const hand = { ...initial, rightHand: 'nextHand' }, foot = { ...hand, leftFoot: 'nextFoot' };
  const depths = { lh: 1.2, rh: 1.8, lf: 0.8, rf: 0.9, nextHand: 2.4, nextFoot: 1.4 };
  // Identical endpoint torsos isolate the deliberate in-between movement.
  const stance = { x: 0, y: 38, theta: 0, hipTheta: 0 };
  const pose = contacts => IK.poseAt(stance, contacts, wall);
  const raised = Object.fromEntries(Object.entries(wall).map(([key, p]) => [key, { ...p, z: depths[key] }]));
  const timeline = Animation.create({
    ok: true, initialPose: pose(initial), initialContacts: initial,
    steps: [{ limb: 'rightHand', id: 'nextHand', contacts: hand, pose: pose(hand) },
      { limb: 'leftFoot', id: 'nextFoot', contacts: foot, pose: pose(foot) }],
  }, raised);
  const [reach, step] = timeline.segments;
  const sample = (segment, t) => timeline.sample(segment.start + t * segment.duration).pose;
  const loaded = sample(reach, reach.release - 0.01), airborne = sample(reach, 0.5);
  assert.deepEqual(loaded.points.rightHand, wall.rh);
  assert.equal(loaded.depth.rightHand, depths.rh);
  assert.ok(loaded.torso.x > 1 && loaded.torso.y < stance.y);
  assert.ok(loaded.depth.rightHip < loaded.depth.leftHip && loaded.depth.pelvis < sample(reach, 0).depth.pelvis);
  assert.ok(airborne.torso.theta > 0);
  assert.equal(airborne.torso.hipTheta, loaded.torso.hipTheta, 'a hand reach should not swivel the pelvis');
  assert.equal(airborne.torso.space.hipYaw, loaded.torso.space.hipYaw);
  assert.deepEqual(airborne.feet.right.heel, loaded.feet.right.heel);
  assert.ok(sample(reach, 0).diagnostics.centerOfMass.z > 11);
  assert.ok(sample(reach, 0).depth.pelvis > sample(reach, 0).depth.neck);
  assert.ok(airborne.motion.airborne && airborne.motion.grip < 0.5);
  assert.ok(airborne.depth.rightHand > depths.nextHand);
  assert.deepEqual(airborne.diagnostics.supportHull, IK.convexHull([wall.lh, wall.lf, wall.rf]));
  const stepping = sample(step, (step.release + step.catch) / 2);
  assert.equal(stepping.motion.supportFoot, 'rightFoot');
  assert.deepEqual(stepping.points.rightFoot, wall.rf);
  assert.equal(stepping.depth.rightFoot, depths.rf);
  assert.ok(stepping.depth.leftFoot > depths.nextFoot);
  assert.deepEqual(stepping.feet.right.ankle, loaded.feet.right.ankle);
  assert.ok(Math.abs(stepping.torso.space.hipYaw - loaded.torso.space.hipYaw) < 0.12);
  assert.ok(stepping.points.leftFoot.y > (wall.lf.y + wall.nextFoot.y) / 2 + 1);
  assert.deepEqual(sample(step, 1).points.leftFoot, wall.nextFoot);
  assert.equal(sample(step, 1).depth.leftFoot, depths.nextFoot);
  const balance = IK.supportForces(stepping);
  const gravity = Board.toWorld(Object.values(balance.gravity));
  assert.ok(Math.abs(gravity[2]) < 1e-9 && Math.abs(gravity[1] + 1) < 1e-9);
  assert.deepEqual(balance.contacts.map(c => c.limb), ['leftHand', 'rightHand', 'rightFoot']);
  assert.ok(balance.contacts.every(({ limb, force }) => limb.endsWith('Foot') ? force.z >= 0 : force.z <= 0));
  assert.ok(Number.isFinite(balance.forceResidual) && Number.isFinite(balance.torqueResidual));
});

test('hold forces oppose gravity and its turning moment in a supported hang', () => {
  const pose = {
    diagnostics: { centerOfMass: { x: 0, y: 45, z: 17.5 } },
    points: { leftHand: { x: -12, y: 55 }, rightHand: { x: 12, y: 55 },
      leftFoot: { x: -12, y: 25 }, rightFoot: { x: 12, y: 25 } },
    depth: { leftHand: 1, rightHand: 1, leftFoot: 1, rightFoot: 1 },
  };
  const balance = IK.supportForces(pose);
  assert.ok(balance.forceResidual < 0.06);
  assert.ok(balance.torqueResidual < 1);
  assert.ok(balance.contacts.filter(c => c.limb.endsWith('Foot')).every(c => c.force.y > 0.06));
  const range=IK.forceRanges(pose,balance);
  assert.ok(range.scenarios>1);
  assert.ok(range.rows.some(row=>row.max-row.min>1));
  assert.ok(range.rows.every(row=>row.min<=row.percent && row.percent<=row.max && row.max<=200));
  assert.equal(IK.forceRanges(pose,{...balance,forceResidual:.8}),null);
});

test('a mapped grip anchors the hand and force at the same hold patch',()=>{
  const placements=new Map([
    ['lh',{x:-12,y:57,z:1,gripPatch:{x:-11.3,y:57.7,z:1,width:2}}],
    ['rh',{x:12,y:56,z:1,gripPatch:{x:12.2,y:57,z:1,width:4}}],
    ['lf',{x:-11,y:12,z:1}],['rf',{x:12,y:12,z:1}],
  ]);
  const contacts={leftHand:'lh',rightHand:'rh',leftFoot:'lf',rightFoot:'rf'};
  const pose=IK.poseAt({x:0,y:37,theta:0},contacts,placements,
    {space:{depth:15,pitch:-.24,hipYaw:0,chestYaw:0}});
  assert.deepEqual(pose.points.leftHand,{x:-11.3,y:57.7});
  const reactions=IK.supportForces(pose);
  assert.deepEqual(reactions.contacts[0].origin,{x:-11.3,y:57.7,z:1});
  assert.ok(pose.diagnostics.jointAnglesDeg.leftDigit2PIP>pose.diagnostics.jointAnglesDeg.rightDigit2PIP);
  assert.ok(pose.diagnostics.jointAnglesDeg.leftWrist>1);
  assert.ok(pose.hands.left.fingers.every(chain=>chain.every(point=>Number.isFinite(point.z))));
});

test('a cross-body grip clears the head and neck without moving the hand', () => {
  const placements = {
    lh: { x: 2, y: 57, z: 1 }, rh: { x: 14, y: 66, z: 1 },
    lf: { x: -8, y: 15, z: 1 }, rf: { x: 11, y: 16, z: 1 },
  };
  const contacts = { leftHand: 'lh', rightHand: 'rh', leftFoot: 'lf', rightFoot: 'rf' };
  const pose = IK.poseAt({ x: 0, y: 38, theta: -0.23 }, contacts, placements,
    { space: { depth: 8, pitch: -0.24, hipYaw: 0, chestYaw: 0 } });
  assert.ok(pose.diagnostics.minArmClearance > 1);
  assert.ok(pose.diagnostics.maxSegmentResidual < 0.01);
  assert.deepEqual(pose.points.leftHand, { x: 2, y: 57 });
  assert.equal(pose.depth.leftHand, 1);
});

test('a high toe near the pelvis can keep its knee below and toward the wall', () => {
  const placements = {
    lh: { x: -10, y: 59, z: 1 }, rh: { x: 12, y: 64, z: 1 },
    lf: { x: -1, y: 40, z: 1 }, rf: { x: -10, y: 18, z: 1 },
  };
  const contacts = { leftHand: 'lh', rightHand: 'rh', leftFoot: 'lf', rightFoot: 'rf' };
  const pose = IK.poseAt({ x: 0, y: 38, theta: -0.2 }, contacts, placements,
    { space: { depth: 9, pitch: -0.24, hipYaw: 0.16, chestYaw: 0 } });
  const { leftHip, leftKnee } = pose.points;
  assert.ok(leftHip.y - leftKnee.y > 6);
  assert.ok(Math.abs(leftHip.x - leftKnee.x) < 8);
  assert.ok(pose.depth.leftKnee < pose.depth.leftHip);
  assert.ok(pose.diagnostics.maxSegmentResidual < 0.01);
  assert.deepEqual(pose.points.leftFoot, { x: -1, y: 40 });
  assert.equal(pose.depth.leftFoot, 1);
});
