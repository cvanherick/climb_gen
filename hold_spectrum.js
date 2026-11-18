/* Ordinal, provisional manufacturer-chart tiers. Unknown is not easy. */
(function(root) {
  const FEATURE_NAMES = ['handTierMean','handTierMax','handEasyShare','handIntermediateShare','handAdvancedShare','handHardShare','handTierCoverage','footBestMean','footWorstMean','footDirectionSpread','footTierCoverage','woodShare'];
  const get = (p) => p?.difficulty || root.CLIMBGEN_HOLD_SPECTRUM?.holds?.[p?.id];
  function apply(placements, data = root.CLIMBGEN_HOLD_SPECTRUM) {
    if (!data || data.layout_id !== 10) return;
    const rows = placements instanceof Map ? [...placements.values()] : placements;
    for (const p of rows) {
      const h = data.holds[p.id];
      if (!h || h.x !== p.x || h.y !== p.y) throw Error(`Difficulty profile coordinate mismatch #${p.id}`);
    }
    for (const p of rows) p.difficulty = data.holds[p.id];
  }
  const mean = (a) => a.length ? a.reduce((s,x)=>s+x,0)/a.length : 0;
  function routeFeatures(holds, placements) {
    const lookup = (id) => placements instanceof Map ? placements.get(String(id)) || placements.get(id) : placements[id];
    const rows = holds.map(h=>({ p:lookup(Array.isArray(h)?h[0]:h.id), role:Number(Array.isArray(h)?h[1]:h.role) })).filter(r=>r.p);
    const hands=rows.filter(r=>[5,6,7].includes(r.role)), feet=rows.filter(r=>r.role===8);
    const tiers=hands.map(r=>get(r.p)?.handTier).filter(x=>Number.isInteger(x));
    const foot=feet.map(r=>get(r.p)?.footApproaches || []).filter(a=>a.length);
    const best=foot.map(a=>Math.min(...a.map(x=>x.tier))), worst=foot.map(a=>Math.max(...a.map(x=>x.tier)));
    return [mean(tiers),tiers.length?Math.max(...tiers):0,...[0,1,2,3].map(t=>tiers.filter(x=>x===t).length/Math.max(1,hands.length)),tiers.length/Math.max(1,hands.length),mean(best),mean(worst),mean(worst.map((x,i)=>x-best[i])),foot.length/Math.max(1,feet.length),rows.filter(r=>get(r.p)?.material==='wood').length/Math.max(1,rows.length)];
  }
  function footDifficulty(placement, hip) {
    const profile=get(placement), approaches=profile?.footApproaches || [];
    if(!approaches.length) return { known:false, cost:0, tier:null };
    const angle=Math.atan2(hip.y-placement.y,hip.x-placement.x)*180/Math.PI;
    const choices=approaches.map(a=>({tier:a.tier, mismatch:Math.abs(((angle-a.angleDeg+540)%360)-180)}));
    const selected=choices.sort((a,b)=>a.mismatch-b.mismatch)[0];
    // Directional labels affect effort, never geometric limb length or hard
    // reachability. Unlisted approaches incur a soft preference only.
    return {known:true,tier:selected.tier,angleDeg:angle,cost:(selected.tier/3+Math.max(0,selected.mismatch-40)/140)*(profile.footConfidence || 0)};
  }
  const api={apply,routeFeatures,footDifficulty,FEATURE_NAMES};
  root.ClimbGenHoldSpectrum=api;
  if(typeof module==='object' && module.exports)module.exports=api;
})(globalThis);
