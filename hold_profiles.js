/* Screenshot estimates are soft direction priors, never grip-force limits. */
(function (root) {
  function apply(placements, data = root.CLIMBGEN_HOLD_PROFILES, annotations = {}) {
    if (!data?.holds || data.layout_id !== 10) throw new Error('Expected TB2 Mirror layout 10 hold profiles.');
    const entries = placements instanceof Map ? [...placements.values()] : placements;
    // Validate the complete join before mutating any placement.
    for (const p of entries) {
      const h = data.holds[p.id];
      if (!h || Math.abs(h.x - p.x) > 0.01 || Math.abs(h.y - p.y) > 0.01) throw new Error(`Hold profile coordinates differ for #${p.id}`);
    }
    for (const p of entries) {
      const h = data.holds[p.id], override = annotations[p.id];
      p.profile = { ...h, pull: { ...h.pull } };
      if (override) p.profile = { ...p.profile, pull: { x: override.dx, y: -override.dy }, unknown: override.unknown === true,
        verified: override.verified === true && !override.unknown, confidence: override.verified === true ? 'reviewed' : 'unknown' };
    }
    return entries.length;
  }
  function parseAnnotations(document, data = root.CLIMBGEN_HOLD_PROFILES) {
    if (document?.layout_id !== 10 || !document.reviewed_annotations || typeof document.reviewed_annotations !== 'object' || Array.isArray(document.reviewed_annotations)) throw new Error('Import a layout 10 JSON export from the supplied hold editor.');
    const out = {};
    for (const [id, value] of Object.entries(document.reviewed_annotations)) {
      if (!data?.holds?.[id] || !value || typeof value.unknown !== 'boolean' || typeof value.verified !== 'boolean' || !Number.isFinite(value.dx) || !Number.isFinite(value.dy)) throw new Error(`Invalid annotation for #${id}`);
      const norm = Math.hypot(value.dx, value.dy);
      if (!value.unknown && (norm < 0.01 || norm > 2)) throw new Error(`Invalid direction for #${id}`);
      out[id] = { dx: value.unknown ? 0 : value.dx / norm, dy: value.unknown ? 0 : value.dy / norm, unknown: value.unknown, verified: value.verified };
    }
    return out;
  }
  const api = { apply, parseAnnotations };
  root.ClimbGenHoldProfiles = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(globalThis);
