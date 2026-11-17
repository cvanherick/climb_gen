/* Lightweight inference for a learned TB2 grade and community-quality model. */
(function attach(root, factory) {
  const api = factory(() => root?.CLIMBGEN_ROUTE_EVALUATOR || null);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ClimbGenRouteEvaluator = api;
})(typeof globalThis === 'object' ? globalThis : this, (getModel) => {
  const FEATURE_NAMES = ['starts', 'hands', 'finishes', 'feet', 'handMeanX', 'handMeanY', 'handSpanX', 'handSpanY', 'routeMeanX', 'routeMeanY', 'routeSpanX', 'routeSpanY', 'handPairMean', 'nearestMean', 'finishProgress', 'bboxDensity'];
  function featureVector(holds, placements) {
    const lookup = (id) => placements instanceof Map ? placements.get(String(id)) || placements.get(id) : placements?.[String(id)];
    const points = (holds || []).map((entry) => {
      const id = Array.isArray(entry) ? entry[0] : entry.id;
      const role = Number(Array.isArray(entry) ? entry[1] : entry.role);
      const position = lookup(id);
      return position ? { x: Number(position.x), y: Number(position.y), role } : null;
    }).filter((point) => point && Number.isFinite(point.x) && Number.isFinite(point.y));
    const starts = points.filter((p) => p.role === 5), hands = points.filter((p) => p.role === 6 || p.role === 7);
    const finishes = points.filter((p) => p.role === 7), feet = points.filter((p) => p.role === 8);
    const active = points.filter((p) => p.role === 5 || p.role === 6 || p.role === 7);
    const mean = (items, key) => items.length ? items.reduce((sum, p) => sum + p[key], 0) / items.length : 0;
    const span = (items, key) => items.length ? Math.max(...items.map((p) => p[key])) - Math.min(...items.map((p) => p[key])) : 0;
    let pairTotal = 0, pairCount = 0;
    for (let i = 0; i < hands.length; i++) for (let j = i + 1; j < hands.length; j++) { pairTotal += Math.hypot(hands[i].x - hands[j].x, hands[i].y - hands[j].y); pairCount++; }
    const nearestDistances = hands.map((p, i) => {
      const distances = hands.filter((_, j) => j !== i).map((q) => Math.hypot(p.x - q.x, p.y - q.y));
      return distances.length ? Math.min(...distances) : NaN;
    }).filter(Number.isFinite);
    const bboxArea = Math.max(1, span(active, 'x') * span(active, 'y'));
    return [starts.length, hands.length, finishes.length, feet.length, mean(hands, 'x'), mean(hands, 'y'), span(hands, 'x'), span(hands, 'y'), mean(active, 'x'), mean(active, 'y'), span(active, 'x'), span(active, 'y'), pairCount ? pairTotal / pairCount : 0, nearestDistances.length ? nearestDistances.reduce((a, b) => a + b, 0) / nearestDistances.length : 0, mean(finishes, 'y') - mean(starts, 'y'), points.length / bboxArea];
  }
  function create(model = getModel()) {
    if (!model?.featureNames || !model?.gradeWeights || !model?.qualityWeights) return null;
    const gradeLabels = model.gradeLabels || [];
    function predict(holds, placements) {
      const raw = featureVector(holds, placements);
      const x = raw.map((value, index) => (value - model.featureMean[index]) / model.featureScale[index]);
      const logits = model.gradeWeights.map((weights, i) => weights.reduce((sum, weight, j) => sum + weight * x[j], model.gradeBias[i]));
      const maxLogit = Math.max(...logits), exp = logits.map((value) => Math.exp(value - maxLogit));
      const total = exp.reduce((a, b) => a + b, 0) || 1;
      const probabilities = exp.map((value) => value / total);
      const expectedGrade = probabilities.reduce((sum, probability, index) => sum + probability * Number(gradeLabels[index].slice(1)), 0);
      const quality = Math.max(1, Math.min(5, model.qualityBias + model.qualityWeights.reduce((sum, weight, index) => sum + weight * x[index], 0)));
      return { predictedGrade: `V${Math.max(0, Math.min(11, Math.round(expectedGrade)))}`, expectedGrade, quality, gradeProbabilities: Object.fromEntries(gradeLabels.map((grade, i) => [grade, probabilities[i]])) };
    }
    function score(holds, placements, targetGrade) {
      const prediction = predict(holds, placements);
      const target = /^V(?:[0-9]|10|11)$/.test(String(targetGrade)) ? Number(String(targetGrade).slice(1)) : prediction.expectedGrade;
      return { ...prediction, rankScore: prediction.quality - 0.85 * Math.abs(prediction.expectedGrade - target) };
    }
    return { predict, score, featureVector, metadata: model.metadata || {} };
  }
  return { create, featureVector };
});
