"""Extract colored circles from the supplied 4338x4339 manufacturer chart.
Requires Pillow, NumPy, SciPy and OpenCV. The resulting labels remain provisional.
"""
import argparse
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser()
parser.add_argument('image',type=Path)
parser.add_argument('--catalog',type=Path,default=ROOT/'docs/hold-references/official-hold-index.json')
parser.add_argument('--output',type=Path,default=ROOT/'docs/hold-references/spectrum-chart-observations.json')
args=parser.parse_args()
from PIL import Image
import numpy as np,cv2,json
from scipy.optimize import least_squares
from scipy.spatial import cKDTree
table=json.loads(args.catalog.read_text())['spray']
positions=np.array([[r['Hold Coordinate Location (Column)']*8,r['Hold Coordinate Location (Row)']*8-4] for r in table if abs(r['Hold Coordinate Location (Column)'])<=8 and r['Hold Coordinate Location (Row)']<=18]);tree=cKDTree(positions)
im=np.array(Image.open(args.image).convert('RGB'))
if im.shape[:2] != (4339,4338): raise ValueError('Expected original 4338x4339 chart; panel coordinates must be recalibrated for other images')
boxes=[(136,850,1104,1818),(1170,850,2138,1818),(2204,850,3172,1818),(3238,850,4206,1818)]
allrows=[]
for tier,(x,y,x2,y2) in enumerate(boxes):
 a=im[y:y2,x:x2].astype(float);r,g,b=a.transpose(2,0,1)
 mask=[(g>180)&(g>r*1.5)&(g>b*1.4),(b>150)&(b>r*1.6)&(b>g*1.3),(r>185)&(g>115)&(b<135)&(r>b*1.6),(r>160)&(b>150)&(g<165)&(b>g*1.2)][tier]
 circles=cv2.HoughCircles((mask*255).astype('uint8'),cv2.HOUGH_GRADIENT,dp=1,minDist=27,param1=100,param2=16,minRadius=18,maxRadius=25)
 pts=circles[0,:,:2] if circles is not None else np.zeros((0,2))
 def residual(p):
  board=np.column_stack(((pts[:,0]-p[0])/p[2],(p[1]-pts[:,1])/p[3]));_,idx=tree.query(board);return (board-positions[idx]).flatten()
 fit=least_squares(residual,[484,966,6.65,6.65]);board=np.column_stack(((pts[:,0]-fit.x[0])/fit.x[2],(fit.x[1]-pts[:,1])/fit.x[3]));dist,idx=tree.query(board)
 print(tier,len(pts),fit.x,'good',sum(dist<1),'max',max(dist))
 for point,d,i in zip(pts,dist,idx):
  if d<1:
   allrows.append(dict(tier=tier,x=int(positions[i,0]),y=int(positions[i,1]),error=float(d),pixel=[float(point[0]+x),float(point[1]+y)]))
args.output.write_text(json.dumps(allrows,indent=2)+'\n')
