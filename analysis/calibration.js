/* Calibrate the 144-inch TB2 face from four normalized image coordinates. */
(function (root) {
  const corners = [[-72, 144], [72, 144], [72, 0], [-72, 0]];
  const dot = (a, b) => a.reduce((sum, x, i) => sum + x * b[i], 0);
  const unit = v => v.map(x => x / Math.hypot(...v));
  const cross = ([x,y,z], [a,b,c]) => [y*c-z*b, z*a-x*c, x*b-y*a];
  function homography(source, destination) {
    const matrix = source.flatMap(([x, y], i) => {
      const { x: u, y: v } = destination[i];
      return [[x,y,1,0,0,0,-u*x,-u*y,u], [0,0,0,x,y,1,-v*x,-v*y,v]];
    });
    for (let i = 0; i < 8; i++) {
      let pivot = i;
      for (let j = i + 1; j < 8; j++) if (Math.abs(matrix[j][i]) > Math.abs(matrix[pivot][i])) pivot = j;
      [matrix[i], matrix[pivot]] = [matrix[pivot], matrix[i]];
      const value = matrix[i][i];
      if (Math.abs(value) < 1e-10) throw new Error('The board corners are too close together.');
      matrix[i] = matrix[i].map(x => x / value);
      for (let j = 0; j < 8; j++) if (j !== i) {
        const factor = matrix[j][i];
        matrix[j] = matrix[j].map((x, k) => x - factor * matrix[i][k]);
      }
    }
    return [...matrix.map(row => row[8]), 1];
  }
  function transform(h, x, y) {
    const w = h[6]*x + h[7]*y + h[8];
    return { x: (h[0]*x + h[1]*y + h[2])/w, y: (h[3]*x + h[4]*y + h[5])/w };
  }
  function calibrate(points, aspect = 1) {
    if (points.length !== 4 || points.some(p => ![p.x,p.y].every(Number.isFinite))) throw new Error('Mark all four corners.');
    for (let i = 0; i < 4; i++) {
      const a = points[i], b = points[(i+1)%4], c = points[(i+2)%4];
      if ((b.x-a.x)*(c.y-b.y)-(b.y-a.y)*(c.x-b.x) <= .001) {
        throw new Error('Mark the corners clockwise, starting at the upper left.');
      }
    }
    const h = homography(corners, points);
    const inverse = homography(points.map(p => [p.x,p.y]), corners.map(([x,y]) => ({x,y})));
    const project = (x, y) => transform(h, x, y);
    const unproject = (x, y) => transform(inverse, x, y);
    // Estimate a pinhole camera with square pixels and a centered principal
    // point. A nearly frontal view cannot determine focal length from corners.
    const columns = [0,1,2].map(i => [(h[i]-.5*h[i+6])*aspect, h[i+3]-.5*h[i+6], h[i+6]]);
    const [a,b,t] = columns;
    const normal = [a[2]*b[2], a[2]**2-b[2]**2];
    const tangent = [-(a[0]*b[0]+a[1]*b[1]), b[0]**2+b[1]**2-a[0]**2-a[1]**2];
    const f2 = dot(normal,tangent)/dot(normal,normal);
    const focalKnown = f2 > .16 && f2 < 16;
    const focal = focalKnown ? Math.sqrt(f2) : Math.max(1, aspect*.8);
    const scaled = ([x,y,z]) => [x/focal,y/focal,z];
    const ax = scaled(a), ay = scaled(b);
    const rx = unit(ax);
    const ry = unit(ay.map((x,i) => x - dot(ay,rx)*rx[i]));
    const rz = cross(rx,ry);
    const axes = [rx,ry,rz];
    const scale = 2/(Math.hypot(...ax)+Math.hypot(...ay));
    const translation = scaled(t).map(x => x * scale);
    const cameraOrigin = axes.map(axis => -dot(translation,axis));
    const relative = (x,y,z) => axes.map(axis => dot([x,y,z],axis));
    function lift(x,y,z) {
      const plane = unproject(x,y);
      // Intersect the image ray with a plane parallel to the face at a
      // model-supplied depth. This does not estimate depth from the pixels.
      const fraction = Math.abs(cameraOrigin[2]) > 20 ? z / cameraOrigin[2] : 0;
      return [plane.x + (cameraOrigin[0]-plane.x)*fraction, plane.y + (cameraOrigin[1]-plane.y)*fraction, z];
    }
    return { project, unproject, lift, relative, focalKnown };
  }
  const api = { calibrate };
  root.ClimbGenCalibration = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(globalThis);
