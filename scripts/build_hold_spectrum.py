"""Rebuild provisional tier labels from chart observations and official indexes."""
import collections
import json
import re
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
catalog=json.loads((ROOT/'docs/hold-references/official-hold-index.json').read_text())
observations=json.loads((ROOT/'docs/hold-references/spectrum-chart-observations.json').read_text())
path=ROOT/'data/tb2-hold-spectrum.js'
old=json.JSONDecoder().raw_decode(path.read_text().split(' = ',1)[1])[0]
family=lambda r:r['Material'].lower()+':'+re.sub(r'(?<=\d)[LR]$','',r['Hold Identification'].upper())
coordinates=lambda rows:{(r['Hold Coordinate Location (Column)']*8,r['Hold Coordinate Location (Row)']*8-4):r for r in rows}
spray=coordinates(catalog['spray']);mirror=coordinates(catalog['mirror']);votes=collections.defaultdict(list)
for row in observations:
    votes[family(spray[row['x'],row['y']])].append(row['tier'])
# Approach angle points from the contact toward the climber's hip. These chart
# shape matches and reference orientations are provisional, not force normals.
foot_templates={'7S':[(90,0)],'6S':[(90,1)],'74S':[(90,3)],'77S':[(90,0),(270,0)],'61S':[(90,2),(0,1),(180,1)],'FT':[(90,1),(270,3)],'35L':[(45,1),(135,2)],'35R':[(135,1),(45,2)],'9L':[(45,1),(135,2)],'9R':[(135,1),(45,2)],'8S':[(45,2),(135,2)]}
# Full sixteen-point compass; keep intercardinal positions exact.
compass=['E','ENE','NE','NNE','N','NNW','NW','WNW','W','WSW','SW','SSW','S','SSE','SE','ESE']
for h in old['holds'].values():
    row=mirror[h['x'],h['y']];labels=votes.get(family(row),[])
    h['handTier']=labels[0] if labels and len(set(labels))==1 else None
    h['handConfidence']=0.7 if h['handTier'] is not None else 0
    h['handEvidenceCount']=len(labels);h['handConflicting']=len(set(labels))>1
    rotation=compass.index(row['Hold Directionality'])*22.5-(90 if h['shape']=='FT' else 270)
    h['footApproaches']=[{'angleDeg':(a+rotation)%360,'tier':t} for a,t in foot_templates.get(h['shape'],[])]
    h['footConfidence']=0.7 if h['footApproaches'] else 0
path.write_text('globalThis.CLIMBGEN_HOLD_SPECTRUM = '+json.dumps(old,separators=(',',':'))+';\n')
print('Hand-tier coverage:',sum(h['handTier'] is not None for h in old['holds'].values()),'/ 498')
