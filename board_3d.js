/* Interactive spatial view of the TB2 Mirror and its solved climber pose. */
(function (root, factory) {
  const api = factory();
  root.ClimbGenBoard3D = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(globalThis, () => {
  const angle = 40 * Math.PI / 180;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const toWorld = ([x, y, z]) => [x, y * cos - z * sin, y * sin + z * cos];
  const fromWorld = ([x, y, z]) => [x, y * cos + z * sin, z * cos - y * sin];
  const add = (a, b) => a.map((value, i) => value + b[i]);
  const sub = (a, b) => a.map((value, i) => value - b[i]);
  const scale = (v, amount) => v.map(value => value * amount);
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const unit = v => scale(v, 1 / (Math.hypot(...v) || 1));
  const mix = (a, b, t) => add(scale(a, 1 - t), scale(b, t));
  const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
  const palette = { 5: [.22, 1, .33], 6: [.21, .57, 1], 7: [1, .22, .25], 8: [.99, .29, .84] };
  const skin = [.72, .48, .32], shirt = [.98, .60, .29], pants = [.13, .30, .34], rubber = [.14, .17, .18];
  const defaultView = { yaw: .47, pitch: .21, distance: 258 };

  function gripPatch(hold,spec) {
    if (!spec?.outline?.length) return null;
    const reviewed=hold.profile?.verified && !hold.profile.unknown && hold.profile.pull;
    const toward=reviewed ? unit([-reviewed.x,-reviewed.y,0]) : [0,1,0];
    const across=[-toward[1],toward[0],0];
    const ranked=spec.outline.map(([x,y])=>({x,y,reach:x*toward[0]+y*toward[1]})).sort((a,b)=>b.reach-a.reach);
    const [tip,neighbor=tip]=ranked;
    const widths=spec.outline.map(([x,y])=>x*across[0]+y*across[1]);
    // Stay just inside the top band of the reconstructed hold mesh.
    const rim=.43;
    return {x:hold.x+rim*(tip.x*.75+neighbor.x*.25),y:hold.y+rim*(tip.y*.75+neighbor.y*.25),z:spec.depth,
      width:Math.max(...widths)-Math.min(...widths),reviewed:Boolean(reviewed)};
  }
  function contactPlacements(placements, geometry) {
    return new Map([...placements].map(([id,hold])=>{
      const spec=geometry?.holds?.[id];
      return [id,{...hold,z:spec?.depth||0,gripPatch:gripPatch(hold,spec)}];
    }));
  }

  class Mesh {
    constructor() { this.data = []; }
    triangle(a, b, c, color) {
      const normal = unit(toWorld(cross(sub(b, a), sub(c, a))));
      for (const point of [a, b, c]) this.data.push(...toWorld(point), ...normal, ...color);
    }
    quad(a, b, c, d, color) {
      this.triangle(a, b, c, color);
      this.triangle(a, c, d, color);
    }
    box(x0, y0, z0, x1, y1, z1, color) {
      this.quad([x0,y0,z1], [x1,y0,z1], [x1,y1,z1], [x0,y1,z1], color);
      this.quad([x1,y0,z0], [x0,y0,z0], [x0,y1,z0], [x1,y1,z0], color);
      this.quad([x0,y0,z0], [x0,y0,z1], [x0,y1,z1], [x0,y1,z0], color);
      this.quad([x1,y0,z1], [x1,y0,z0], [x1,y1,z0], [x1,y1,z1], color);
      this.quad([x0,y1,z1], [x1,y1,z1], [x1,y1,z0], [x0,y1,z0], color);
      this.quad([x0,y0,z0], [x1,y0,z0], [x1,y0,z1], [x0,y0,z1], color);
    }
    tube(a, b, r0, r1, color) {
      const axis = unit(sub(b, a));
      const across = unit(cross(Math.abs(axis[2]) > .9 ? [0, 1, 0] : [0, 0, 1], axis));
      const second = cross(axis, across);
      const ring = (center, radius, step) => {
        const theta = step * Math.PI / 4;
        return add(center, add(scale(across, radius * Math.cos(theta)), scale(second, radius * Math.sin(theta))));
      };
      for (let i = 0; i < 8; i++) {
        const start = ring(a, r0, i), next = ring(a, r0, i + 1);
        const end = ring(b, r1, i), nextEnd = ring(b, r1, i + 1);
        this.quad(start, next, nextEnd, end, color);
        this.triangle(a, next, start, color);
        this.triangle(b, end, nextEnd, color);
      }
    }
    ellipsoid(center, size, color) {
      const point = (row, col) => {
        const latitude = row / 6 * Math.PI - Math.PI / 2, longitude = col / 8 * 2 * Math.PI;
        return add(center, [
          size[0] * Math.cos(latitude) * Math.cos(longitude),
          size[1] * Math.sin(latitude),
          size[2] * Math.cos(latitude) * Math.sin(longitude),
        ]);
      };
      for (let y = 0; y < 6; y++) for (let x = 0; x < 8; x++) {
        this.quad(point(y, x), point(y + 1, x), point(y + 1, x + 1), point(y, x + 1), color);
      }
    }
  }

  function drawHold(mesh, hold, spec) {
    const color = scale(spec.color, 1 / 255);
    const bands = [[1, .03], [1, .42], [.79, .83], [.49, 1]];
    const ring = (i, [width, height]) => {
      const [x, y] = spec.outline[i % spec.outline.length];
      return [hold.x + x * width, hold.y + y * width, spec.depth * height];
    };
    for (let i = 0; i < spec.outline.length; i++) {
      for (let j = 1; j < bands.length; j++) {
        mesh.quad(ring(i, bands[j - 1]), ring(i + 1, bands[j - 1]), ring(i + 1, bands[j]), ring(i, bands[j]), color);
      }
      mesh.triangle(ring(i, bands.at(-1)), ring(i + 1, bands.at(-1)), [hold.x, hold.y, spec.depth], color);
    }
  }
  function drawIndicator(mesh, hold, spec, color, focused) {
    const z = spec.depth + .1, radius = Math.max(2.1, ...spec.outline.map(([x, y]) => Math.hypot(x, y))) + .48;
    const point = (r, i) => [hold.x + r * Math.cos(i * Math.PI / 12), hold.y + r * Math.sin(i * Math.PI / 12), z];
    const width = focused ? 1.14 : .75;
    for (let i = 0; i < 24; i++) {
      mesh.quad(point(radius - width, i), point(radius, i), point(radius, i + 1), point(radius - width, i + 1), color);
    }
  }
  function boardMesh(placements, geometry) {
    const mesh = new Mesh();
    const plywood = [[.78,.72,.61], [.8,.75,.65], [.77,.71,.61]];
    // Built in inches: 144 × 144 in face, angled 40° from vertical.
    mesh.box(-72, 0, -1.5, 72, 144, -.11, [.50,.42,.30]);
    for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) {
      mesh.box(-71.92 + col * 48, row * 48 + .08, -.14,
        -24.08 + col * 48, (row + 1) * 48 - .08, 0, plywood[(row * 2 + col) % 3]);
    }
    mesh.quad(...[[-142,-.2,190],[142,-.2,190],[142,-.2,-104],[-142,-.2,-104]].map(fromWorld), [.20,.24,.24]);
    for (let x = -132; x < 142; x += 12) {
      mesh.quad(...[[x,-.18,190],[x+.13,-.18,190],[x+.13,-.18,-104],[x,-.18,-104]].map(fromWorld), [.25,.29,.28]);
    }
    for (let z = -96; z < 190; z += 12) {
      mesh.quad(...[[-142,-.18,z],[142,-.18,z],[142,-.18,z-.13],[-142,-.18,z-.13]].map(fromWorld), [.25,.29,.28]);
    }
    for (const [id, hold] of placements) {
      const spec = geometry.holds[id];
      if (spec) drawHold(mesh, hold, spec);
    }
    return mesh;
  }

  function climberMesh(pose) {
    const mesh = new Mesh();
    if (!pose) return mesh;
    const p = key => [pose.points[key].x, pose.points[key].y, pose.depth?.[key] || 0];
    for (const side of ['left', 'right']) {
      const hip = p(side + 'Hip'), knee = p(side + 'Knee'), ankle = p(side + 'Ankle');
      const shoulder = p(side + 'Shoulder'), elbow = p(side + 'Elbow'), wrist = p(side + 'Wrist');
      const toe = p(side + 'Foot'), heel = p(side + 'Heel'), hand = p(side + 'Hand');
      mesh.tube(hip, knee, 3.1, 1.95, pants);
      mesh.ellipsoid(knee, [1.95,1.95,1.95], pants);
      mesh.tube(knee, ankle, 1.95, 1.1, pants);
      mesh.tube(heel, toe, 1.5, .85, rubber);
      mesh.tube(ankle, mix(heel, toe, .48), 1.13, 1.26, rubber);
      mesh.tube(shoulder, elbow, 2.12, 1.4, skin);
      mesh.ellipsoid(elbow, [1.42,1.42,1.42], skin);
      mesh.tube(elbow, wrist, 1.4, .76, skin);
      mesh.tube(wrist, hand, .79, .89, skin);
      mesh.ellipsoid(hand, [.75, .68, .60], skin);
      for(const chain of pose.hands?.[side]?.fingers || []) {
        for(let i=1;i<chain.length;i++) {
          const from=chain[i-1],to=chain[i];
          mesh.tube([from.x,from.y,from.z],[to.x,to.y,to.z],.19-i*.025,.17-i*.025,skin);
        }
      }
      mesh.tube(shoulder, mix(shoulder, elbow, .30), 2.58, 2.25, shirt);
    }
    const pelvis = p('pelvis'), neck = p('neck'), head = p('head');
    const left = p('leftShoulder'), right = p('rightShoulder');
    const leftHip = p('leftHip'), rightHip = p('rightHip');
    const forward = unit(cross(sub(right, left), sub(neck, pelvis)));
    const torsoRings = [[.08, 1.07, 2.5], [.36, .88, 2.45], [.76, .98, 3.2], [.94, .99, 2.6], [1.06, .40, 1.8]]
      .map(([height, width, thickness]) => {
        const center = mix(pelvis, neck, height);
        const across = scale(mix(sub(rightHip, leftHip), sub(right, left), height), width / 2);
        return Array.from({ length: 12 }, (_, i) => {
          const theta = i * Math.PI / 6;
          return add(center, add(scale(across, Math.cos(theta)), scale(forward, Math.sin(theta) * thickness)));
        });
      });
    for (let row = 1; row < torsoRings.length; row++) {
      const lower = torsoRings[row - 1], upper = torsoRings[row];
      for (let i = 0; i < lower.length; i++) {
        const next = (i + 1) % lower.length;
        mesh.quad(lower[i], upper[i], upper[next], lower[next], shirt);
      }
    }
    mesh.tube(leftHip, rightHip, 2.95, 2.95, pants);
    mesh.tube(neck, head, 1.65, 1.5, skin);
    mesh.ellipsoid(head, [2.85, 3.6, 2.8], skin);
    mesh.ellipsoid(add(head, add(scale(forward, .55), [0,.80,0])), [2.8, 3.0, 2.75], [.22,.17,.14]);
    mesh.ellipsoid(add(mix(pelvis, neck, .05), scale(forward, 4.05)), [2.15, 2.4, 1.6], [.56,.65,.57]);
    return mesh;
  }

  function forceMesh(balance) {
    const mesh = new Mesh();
    if (!balance) return mesh;
    function arrow(from, vector, color) {
      const origin = [from.x, from.y, from.z];
      const direction = [vector.x, vector.y, vector.z];
      const length = Math.hypot(...direction) * 23;
      if (length < 1) return;
      const axis = unit(direction);
      const base = add(origin, scale(axis, length - Math.min(3, length * .36)));
      const tip = add(origin, scale(axis, length));
      mesh.tube(origin, base, .34, .34, color);
      mesh.tube(base, tip, 1.05, .01, color);
    }
    if (!balance.hideCenter) mesh.ellipsoid([balance.center.x, balance.center.y, balance.center.z],
      [1.3, 1.3, 1.3], [1, .76, .26]);
    if (balance.gravity) arrow(balance.center, balance.gravity, [1, .76, .26]);
    for (const { limb, origin, force } of balance.contacts) {
      const direction = balance.onHold ? {x:-force.x,y:-force.y,z:-force.z} : force;
      const color = (balance.analysis || balance.beta) && limb.endsWith('Foot') ? [.91,.53,1] : [.37,.95,1];
      if(balance.beta) mesh.ellipsoid([origin.x,origin.y,origin.z],[.57,.57,.57],color);
      arrow(origin, direction, color);
    }
    return mesh;
  }

  function create(canvas, placements, geometry) {
    if (!geometry || geometry.layoutId !== 10) throw new Error('TB2 Mirror geometry is unavailable.');
    const gl = canvas.getContext('webgl', { alpha: false, antialias: true });
    if (!gl) throw new Error('This browser could not open the 3D view.');
    function shader(type, source) {
      const compiled = gl.createShader(type);
      gl.shaderSource(compiled, source);
      gl.compileShader(compiled);
      if (!gl.getShaderParameter(compiled, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(compiled));
      return compiled;
    }
    const program = gl.createProgram();
    const vertex = shader(gl.VERTEX_SHADER, `
      attribute vec3 position, normal, color;
      uniform vec3 eye, right, up, forward;
      uniform vec2 lens;
      varying lowp vec3 shade;
      void main() {
        vec3 relative = position - eye;
        float depth = dot(relative, forward);
        gl_Position = vec4(dot(relative, right) * lens.x, dot(relative, up) * lens.y,
          depth * 1.00167 - 2.00167, depth);
        vec3 light = normalize(vec3(-0.46, 0.73, 0.78));
        float diffuse = max(0.0, dot(normal, light));
        shade = color * (0.66 + 0.34 * diffuse);
      }`);
    const fragment = shader(gl.FRAGMENT_SHADER, `
      varying lowp vec3 shade;
      void main() { gl_FragColor = vec4(shade, 1.0); }`);
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    gl.useProgram(program);
    gl.enable(gl.DEPTH_TEST);
    gl.clearColor(.055, .086, .09, 1);
    const attributes = ['position', 'normal', 'color'].map(name => gl.getAttribLocation(program, name));
    const uniforms = Object.fromEntries(['eye', 'right', 'up', 'forward', 'lens'].map(name => [name, gl.getUniformLocation(program, name)]));
    attributes.forEach(location => gl.enableVertexAttribArray(location));

    function buffer() { return { id: gl.createBuffer(), vertices: 0 }; }
    function upload(location, mesh, usage) {
      gl.bindBuffer(gl.ARRAY_BUFFER, location.id);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(mesh.data), usage);
      location.vertices = mesh.data.length / 9;
    }
    function paint(location) {
      gl.bindBuffer(gl.ARRAY_BUFFER, location.id);
      attributes.forEach((attribute, i) => gl.vertexAttribPointer(attribute, 3, gl.FLOAT, false, 36, i * 12));
      gl.drawArrays(gl.TRIANGLES, 0, location.vertices);
    }
    const boardBuffer = buffer(), routeBuffer = buffer(), climberBuffer = buffer(), forceBuffer = buffer();
    upload(boardBuffer, boardMesh(placements, geometry), gl.STATIC_DRAW);
    const center = toWorld([0, 72, 0]);
    let view, target, pose, route, activeId, balance, pending = 0;
    let routeDirty = true, poseDirty = true, forcesDirty = true;
    const pointers = new Map();
    function camera() {
      const e = Math.cos(view.pitch);
      const offset = [e * Math.sin(view.yaw), Math.sin(view.pitch), e * Math.cos(view.yaw)];
      const forward = scale(offset, -1);
      const right = unit(cross(forward, [0, 1, 0]));
      return { eye: add(target, scale(offset, view.distance)), forward, right, up: cross(right, forward) };
    }
    function redraw() {
      if (pending) return;
      pending = requestAnimationFrame(() => {
        pending = 0;
        const { clientWidth, clientHeight } = canvas;
        if (!clientWidth || !clientHeight || gl.isContextLost()) return;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const width = Math.round(clientWidth * dpr), height = Math.round(clientHeight * dpr);
        if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
        gl.viewport(0, 0, width, height);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        for (const [key, value] of Object.entries(camera())) gl.uniform3fv(uniforms[key], value);
        // Widen the horizontal field without cutting off the wall on phones.
        const focal = 2.9 * Math.min(1, width / height);
        gl.uniform2f(uniforms.lens, focal * height / width, focal);
        if (routeDirty) {
          const mesh = new Mesh();
          for (const { id, role } of route?.holds || []) {
            const hold = placements.get(String(id)), spec = geometry.holds[id];
            if (hold && spec && palette[role]) drawIndicator(mesh, hold, spec, String(id) === activeId ? [1, .95, .63] : palette[role], String(id) === activeId);
          }
          upload(routeBuffer, mesh, gl.DYNAMIC_DRAW);
          routeDirty = false;
        }
        if (poseDirty) {
          upload(climberBuffer, climberMesh(pose), gl.DYNAMIC_DRAW);
          poseDirty = false;
        }
        if (forcesDirty) {
          upload(forceBuffer, forceMesh(balance), gl.DYNAMIC_DRAW);
          forcesDirty = false;
        }
        paint(boardBuffer);
        paint(routeBuffer);
        paint(climberBuffer);
        // Vectors are annotations. Display reactions even where their line
        // of action points through the wall face.
        if (balance) {
          gl.disable(gl.DEPTH_TEST);
          paint(forceBuffer);
          gl.enable(gl.DEPTH_TEST);
        }
      });
    }
    function preset(name) {
      view = { ...defaultView };
      if (name === 'front') Object.assign(view, { yaw: 0, pitch: -.18 });
      if (name === 'side') Object.assign(view, { yaw: 1.3, pitch: .09, distance: 280 });
      target = [...center];
      redraw();
    }
    function orbit(dx, dy) {
      view.yaw += dx * .009;
      view.pitch = clamp(view.pitch + dy * .009, -.62, 1.15);
      redraw();
    }
    function zoom(factor) {
      view.distance = clamp(view.distance * factor, 32, 650);
      redraw();
    }
    function pan(dx, dy) {
      const { right, up } = camera();
      const factor = view.distance / (1.5 * (canvas.clientHeight || 1));
      target = add(target, add(scale(right, -dx * factor), scale(up, dy * factor)));
      target = target.map((value, i) => clamp(value, center[i] - 150, center[i] + 150));
      redraw();
    }
    canvas.addEventListener('pointerdown', event => {
      if (pointers.size >= 2) return;
      canvas.setPointerCapture(event.pointerId);
      pointers.set(event.pointerId, [event.clientX, event.clientY]);
    });
    canvas.addEventListener('pointermove', event => {
      const previous = pointers.get(event.pointerId);
      if (!previous) return;
      const next = [event.clientX, event.clientY], [dx, dy] = sub(next, previous);
      pointers.set(event.pointerId, next);
      if (pointers.size === 2) {
        const second = [...pointers].find(([id]) => id !== event.pointerId)[1];
        zoom(Math.max(1, Math.hypot(...sub(previous, second))) / Math.max(1, Math.hypot(...sub(next, second))));
        pan(dx / 2, dy / 2);
      } else if (event.shiftKey || event.buttons & 2) pan(dx, dy);
      else orbit(-dx, dy);
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      canvas.addEventListener(type, event => pointers.delete(event.pointerId));
    }
    canvas.addEventListener('contextmenu', event => event.preventDefault());
    canvas.addEventListener('wheel', event => {
      event.preventDefault();
      zoom(Math.exp(clamp(event.deltaY, -160, 160) * .002));
    }, { passive: false });
    canvas.addEventListener('keydown', event => {
      const direction = { ArrowLeft: [12, 0], ArrowRight: [-12, 0], ArrowUp: [0, 12], ArrowDown: [0, -12] }[event.key];
      if (direction) (event.shiftKey ? pan : orbit)(...direction);
      else if (event.key === '+' || event.key === '=') zoom(.88);
      else if (event.key === '-') zoom(1.14);
      else if (event.key === 'Home') preset('reset');
      else return;
      event.preventDefault();
    });
    const resize = new ResizeObserver(redraw);
    resize.observe(canvas);
    preset('reset');
    return {
      preset, zoom,
      focus(point) {
        target=toWorld([point.x,point.y,point.z||0]);
        view.distance=62;
        redraw();
      },
      update(nextRoute, nextActive, nextPose, nextBalance) {
        const id = nextActive == null ? null : String(nextActive);
        if (route !== nextRoute || activeId !== id) routeDirty = true;
        if (pose !== nextPose) poseDirty = true;
        if (balance !== nextBalance) forcesDirty = true;
        route = nextRoute;
        activeId = id;
        pose = nextPose;
        balance = nextBalance;
        redraw();
      },
    };
  }
  return { create, contactPlacements, toWorld };
});
