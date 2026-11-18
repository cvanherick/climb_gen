const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Board = require('../board_3d');
require('../data/tb2-hold-geometry');

test('the 3D panel rotates 40 degrees from vertical and preserves physical scale', () => {
  const top = Board.toWorld([0, 144, 0]);
  assert.ok(Math.abs(Math.hypot(...top) - 144) < 1e-9);
  assert.ok(Math.abs(Math.atan2(top[2], top[1]) * 180 / Math.PI - 40) < 1e-9);
  assert.deepEqual(Board.toWorld([72, 0, 0]), [72, 0, 0]);
});

test('every Mirror hold has a footprint and a corresponding raised playback anchor', () => {
  const context = { window: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../data/tb2-mirror-40.js'), 'utf8'), context);
  const holds = context.window.CLIMBGEN_DATA.placements;
  const geometry = globalThis.CLIMBGEN_HOLD_GEOMETRY;
  const original = new Map(holds.map(hold => [String(hold.id), hold]));
  const anchors = Board.contactPlacements(original, geometry);
  assert.equal(anchors.size, 498);
  assert.equal(Object.keys(geometry.holds).length, 498);
  assert.equal(geometry.depthsEstimated, true);
  for (const [id, anchor] of anchors) {
    const { depth, outline } = geometry.holds[id];
    assert.ok(depth > 0 && depth < 4);
    assert.ok(outline.length >= 3 && outline.every(pair => pair.length === 2 && pair.every(Number.isFinite)));
    assert.deepEqual(anchor, { ...original.get(id), z: depth });
  }
});
