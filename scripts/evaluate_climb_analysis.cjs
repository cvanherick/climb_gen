/* Compare an exported analysis session to manually annotated video intervals. */
const fs = require('node:fs');
const { contactAt } = require('../analysis/analysis_model');

const [sessionPath, annotationPath] = process.argv.slice(2);
if (!sessionPath || !annotationPath) {
  console.error('Usage: node scripts/evaluate_climb_analysis.cjs session.json annotations.json');
  process.exit(1);
}
const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
const annotations = JSON.parse(fs.readFileSync(annotationPath, 'utf8'));
if (session.schemaVersion !== 1 || !Array.isArray(annotations.contacts) || !Array.isArray(annotations.events)) {
  throw new Error('Expected analysis schema 1 and annotation arrays named contacts and events.');
}
const fraction = (number, count) => count ? number / count : null;
let labeled = 0, correct = 0, truePositive = 0, falsePositive = 0, falseNegative = 0;
for (const { t } of session.frames) {
  const actual = contactAt(annotations.contacts, t);
  const predicted = contactAt(session.contacts, t);
  for (const truth of actual) {
    const guess = predicted.find(contact => contact.limb === truth.limb);
    const expected = truth.id == null ? null : String(truth.id);
    const received = guess?.id ?? null;
    labeled++;
    if (expected === received) correct++;
    if (received != null) {
      if (expected === received) truePositive++;
      else falsePositive++;
    }
    if (expected != null && expected !== received) falseNegative++;
  }
}

const eventMatches = [];
const matched = new Set();
const ranges = annotations.reviewedEvents ?? [[0,session.video.duration]];
const predictions = session.events.filter(event => ranges.some(([start,end]) => event.start>=start && event.start<end));
for (const event of predictions) {
  const candidates = annotations.events.map((truth,index)=>({truth,index,error:Math.abs(truth.start-event.start)}))
    .filter(pair=>!matched.has(pair.index) && pair.truth.category===event.category && pair.error<=.4)
    .sort((a,b)=>a.error-b.error);
  if(candidates[0]) {
    const {index,error}=candidates[0];
    matched.add(index);
    eventMatches.push(error);
  }
}
console.log(JSON.stringify({
  poseCoverage: session.poseCoverage,
  reconstructedCoverage: fraction(session.reconstruction.filter(row=>row.pose).length,session.frames.length),
  forceEstimateCoverage: fraction(session.reconstruction.filter(row=>row.forces.balance).length,session.frames.length),
  contact: {
    labeledLimbSamples:labeled, accuracy:fraction(correct,labeled),
    precision:fraction(truePositive,truePositive+falsePositive), recall:fraction(truePositive,truePositive+falseNegative),
  },
  events:{
    precision:fraction(matched.size,predictions.length), recall:fraction(matched.size,annotations.events.length),
    meanStartErrorSeconds:fraction(eventMatches.reduce((a,b)=>a+b,0),eventMatches.length),
  },
}, null, 2));
