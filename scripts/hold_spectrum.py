"""Shared provisional hold-tier features for offline training; no route grade labels."""
import json
import math
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
FEATURE_NAMES=['handTierMean','handTierMax','handEasyShare','handIntermediateShare','handAdvancedShare','handHardShare','handTierCoverage','footBestMean','footWorstMean','footDirectionSpread','footTierCoverage','woodShare']
CONTEXT_NAMES=['handEasy','handIntermediate','handAdvanced','handHard','handKnown','footBest','footWorst','footDirectionSpread','footKnown','wood','markerCos','markerSin']
def load_spectrum():
    raw=(ROOT/'data/tb2-hold-spectrum.js').read_text().split(' = ',1)[1]
    return json.JSONDecoder().raw_decode(raw)[0]
SPECTRUM=load_spectrum()
def route_features(route, placements):
    rows=[(SPECTRUM['holds'].get(str(i),{}),int(role)) for i,role in route['holds'] if int(i) in placements]
    hands=[p for p,r in rows if r in (5,6,7)];feet=[p for p,r in rows if r==8]
    tiers=[p['handTier'] for p in hands if p.get('handTier') is not None]
    foot=[p['footApproaches'] for p in feet if p.get('footApproaches')]
    best=[min(a['tier'] for a in p) for p in foot];worst=[max(a['tier'] for a in p) for p in foot]
    mean=lambda a:sum(a)/len(a) if a else 0
    return [mean(tiers),max(tiers,default=0),*[tiers.count(t)/max(1,len(hands)) for t in range(4)],len(tiers)/max(1,len(hands)),mean(best),mean(worst),mean([b-a for a,b in zip(best,worst)]),len(foot)/max(1,len(feet)),sum(p.get('material')=='wood' for p,r in rows)/max(1,len(rows))]
def hold_context(placements):
    compass=['E','ENE','NE','NNE','N','NNW','NW','WNW','W','WSW','SW','SSW','S','SSE','SE','ESE']
    out=[]
    for p in placements:
        h=SPECTRUM['holds'][str(p['id'])]
        assert p['x']==h['x'] and p['y']==h['y']
        tier=h['handTier'];conf=h['handConfidence'];foot=h['footApproaches'];fc=h['footConfidence'];ts=[a['tier']/3 for a in foot];angle=compass.index(h['installationMarker'])*math.pi/8
        out.append([*[conf if tier==t else 0 for t in range(4)],conf,min(ts,default=0)*fc,max(ts,default=0)*fc,(max(ts,default=0)-min(ts,default=0))*fc,fc,float(h['material']=='wood'),math.cos(angle),math.sin(angle)])
    return out
