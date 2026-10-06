// Sea: a floating block of ocean. A lighthouse islet, a sailboat on a slow lap,
// gulls gliding overhead; fish schools, kelp and bubbles seen through the glassy
// sides; the lighthouse beam and glowing plankton after dusk. Every loop is 5s+.
export function createScene(world) {
  const { THREE, toon, flat, swayToon } = world;
  const R = world.rng(21);
  const R2 = world.rng(4321);
  const root = new THREE.Group();
  // Everything static lives on `frame`: the world measures it to frame the shot.
  const frame = new THREE.Group();
  root.add(frame);
  const SIZE = 20, H = SIZE / 2, DEPTH = 5;
  const ISLET = { x: -3, z: -3.5, r: 3.4 };

  const shadowed = o => { o.traverse(c => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; } }); return o; };
  const box = (w, h, d, mat, x = 0, y = 0, z = 0) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); m.position.set(x, y, z); return m; };
  const cyl = (rt, rb, h, seg, mat, x = 0, y = 0, z = 0) => { const m = new THREE.Mesh(flat(new THREE.CylinderGeometry(rt, rb, h, seg)), mat); m.position.set(x, y, z); return m; };

  // ---------- waves: one definition shared by the shader and the boats ----------
  // [amplitude, kx, kz, angular speed, phase]: periods 4.5s, 7s, 9s.
  const WAVES = [[0.16, 0.55, 0, 0.9, 0], [0.11, 0, 0.8, -0.7, 1.3], [0.06, 1.3, 1.3, 1.4, 0]];
  const waveH = (x, z, t) => WAVES.reduce((h, [a, kx, kz, w, ph]) => h + a * Math.sin(kx * x + kz * z + w * t + ph), 0);
  const f = n => n.toFixed(4);
  const WAVE_GLSL = `float waveH(vec2 p, float t) { return ${WAVES.map(([a, kx, kz, w, ph]) => `${f(a)} * sin(${f(kx)} * p.x + ${f(kz)} * p.y + ${f(w)} * t + ${f(ph)})`).join(' + ')}; }`;

  // ---------- water block ----------
  const waterU = {
    uDeep: { value: new THREE.Color(0x1b5a82) }, uShallow: { value: new THREE.Color(0x3aa3c2) },
    uCrest: { value: new THREE.Color(0x86d3df) }, uFoam: { value: new THREE.Color(0xf2fbff) },
    uIslet: { value: new THREE.Vector2(ISLET.x, ISLET.z) }, uIsletR: { value: ISLET.r + 0.25 },
  };
  const waterMat = toon(0xffffff, { transparent: true });
  waterMat.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, waterU, { uTime: world.uTime });
    sh.vertexShader = `uniform float uTime;\nvarying float vH;\nvarying float vTop;\nvarying vec3 vLocal;\n${WAVE_GLSL}\n`
      + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
        vH = 0.0; vTop = 0.0;
        // Surface and the top edge of each side ride the same wave, so there is never a seam.
        if (position.y > -0.01) { vH = waveH(position.xz, uTime); transformed.y += vH; vTop = step(0.5, normal.y); }
        vLocal = transformed;`);
    sh.fragmentShader = `#define FLAT_SHADED
      uniform float uTime;
      uniform vec3 uDeep, uShallow, uCrest, uFoam;
      uniform vec2 uIslet;
      uniform float uIsletR;
      varying float vH;
      varying float vTop;
      varying vec3 vLocal;
      float hash21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
      float vnoise(vec2 p) {
        vec2 i = floor(p), u = fract(p);
        u = u * u * (3.0 - 2.0 * u);
        return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x), mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x), u.y);
      }
      ` + sh.fragmentShader
      .replace('vec4 diffuseColor = vec4( diffuse, opacity );', `
        vec3 base = mix(uDeep, uShallow, clamp((vLocal.y + ${f(DEPTH)}) / ${f(DEPTH)}, 0.0, 1.0));
        base = mix(base, uShallow, vTop);
        // Small drifting ripple highlights: the pixel-art sparkle on open water.
        // Stretched along the screen's horizontal so highlights read as short dashes.
        vec2 sp = vec2((vLocal.x - vLocal.z) * 0.5, (vLocal.x + vLocal.z) * 1.5);
        float n = vnoise(sp + vec2(uTime * 0.12, uTime * 0.05)) * vnoise(sp * 0.6 - vec2(uTime * 0.07, -uTime * 0.04) + 17.0);
        base = mix(base, uCrest, vTop * step(0.42, n + 0.35 * vH));
        // Waterline along the glass sides.
        base = mix(base, uCrest, (1.0 - vTop) * step(-0.14, vLocal.y - vH));
        vec2 dq = vLocal.xz - uIslet;
        float edge = uIsletR + 0.14 * sin(atan(dq.y, dq.x) * 5.0 + uTime * 0.8) + 0.08 * sin(uTime * 1.1);
        float foam = vTop * step(length(dq), edge);
        base = mix(base, uFoam, foam);
        vec4 diffuseColor = vec4(base, max(mix(0.45, 0.82, vTop), foam));`)
      .replace('#include <opaque_fragment>', `
        #if NUM_DIR_LIGHTS > 0
          // Sun (or moon) glints: facets that mirror the light straight at the camera.
          float glint = dot(reflect(-directionalLights[0].direction, normal), normalize(vViewPosition));
          outgoingLight += vTop * (1.0 - foam) * step(0.993, glint) * directionalLights[0].color * 0.7;
        #endif
        #include <opaque_fragment>`);
  };
  const water = new THREE.Mesh(new THREE.BoxGeometry(SIZE, DEPTH, SIZE, 48, 1, 48).translate(0, -DEPTH / 2, 0), waterMat);
  water.receiveShadow = true;
  water.renderOrder = 1;
  frame.add(water);

  // ---------- sea floor + rock base ----------
  const m4 = new THREE.Matrix4(), col = new THREE.Color();
  const sand = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.16, 1).translate(0, -0.08, 0), toon(0xffffff), SIZE * SIZE);
  let k = 0;
  for (let i = 0; i < SIZE; i++) for (let j = 0; j < SIZE; j++) {
    sand.setMatrixAt(k, m4.makeTranslation(-H + i + 0.5, -DEPTH, -H + j + 0.5));
    sand.setColorAt(k++, col.set(R() < 0.15 ? 0xc6aa76 : 0xdcc38e).offsetHSL(0, 0, (R() - 0.5) * 0.04));
  }
  sand.receiveShadow = true;
  frame.add(sand);
  let y = -DEPTH - 0.16;
  for (const [s, h, c] of [[SIZE, 1.0, 0x8a7a66], [SIZE - 1.6, 1.4, 0x7f7b89], [SIZE - 4.5, 1.3, 0x6d6a79], [SIZE - 9, 1.1, 0x5e5b6a]]) {
    const layer = box(s, h, s, toon(c), 0, y - h / 2, 0);
    layer.receiveShadow = true;
    frame.add(layer);
    y -= h;
  }
  const rockMat = toon(0x6f6a62);
  for (let i = 0; i < 7; i++) {
    const r = 0.3 + R() * 0.5;
    const rock = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 0), rockMat);
    rock.position.set(1 + R() * 8, -DEPTH + r * 0.5, 1 + R() * 8);
    rock.rotation.set(R() * 3, R() * 3, R() * 3);
    frame.add(shadowed(rock));
  }

  // kelp along the two glass sides you look through
  const kelpPts = [];
  while (kelpPts.length < 40) {
    const x = (R() - 0.5) * (SIZE - 1), z = (R() - 0.5) * (SIZE - 1);
    if ((x > 3 || z > 3) && Math.hypot(x - ISLET.x, z - ISLET.z) > ISLET.r + 1.4) kelpPts.push([x, z, 1.2 + R() * 2.2]);
  }
  const kelp = new THREE.InstancedMesh(new THREE.BoxGeometry(0.13, 1, 0.07).translate(0, 0.5, 0), swayToon(0xffffff, 0.12, -DEPTH), kelpPts.length);
  kelpPts.forEach(([x, z, h], i) => {
    kelp.setMatrixAt(i, m4.compose(new THREE.Vector3(x, -DEPTH, z), new THREE.Quaternion(), new THREE.Vector3(1, h, 1)));
    kelp.setColorAt(i, col.set([0x3f7f4a, 0x5a8a3a, 0x6e7a2e][Math.floor(R() * 3)]).offsetHSL(0, 0, (R() - 0.5) * 0.05));
  });
  frame.add(kelp);

  // ---------- islet + lighthouse ----------
  const islet = new THREE.Group();
  islet.position.set(ISLET.x, 0, ISLET.z);
  islet.add(cyl(ISLET.r, ISLET.r + 0.8, DEPTH, 9, toon(0x6f6a62), 0, -DEPTH / 2, 0));
  islet.add(cyl(ISLET.r - 0.1, ISLET.r, 0.5, 9, toon(0xe2cf9c), 0, 0, 0));
  islet.add(cyl(ISLET.r - 0.9, ISLET.r - 0.5, 0.45, 9, toon(0x79b851), 0, 0.45, 0));
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2 + R() * 0.5, r = 0.35 + R() * 0.35;
    const b = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 0), rockMat);
    b.position.set(Math.cos(a) * (ISLET.r - 0.3), 0.2, Math.sin(a) * (ISLET.r - 0.3));
    b.rotation.set(R() * 3, R() * 3, R() * 3);
    islet.add(b);
  }
  const LH = { x: 0.3, z: -0.5, y0: 0.67 };
  const white = toon(0xf3efe6), red = toon(0xc8463c);
  for (let i = 0; i < 4; i++) {
    const rb = 0.8 - i * 0.055, rt = rb - 0.055;
    islet.add(cyl(rt, rb, 1.15, 10, i % 2 ? red : white, LH.x, LH.y0 + 0.575 + i * 1.15, LH.z));
  }
  const top = LH.y0 + 4.6;
  islet.add(cyl(0.88, 0.88, 0.14, 10, toon(0x3b3a40), LH.x, top + 0.07, LH.z));
  const lamp = toon(0x3a4660, { emissive: new THREE.Color(0xffe39a), emissiveIntensity: 0 });
  islet.add(cyl(0.48, 0.48, 0.75, 10, lamp, LH.x, top + 0.52, LH.z));
  islet.add(new THREE.Mesh(flat(new THREE.ConeGeometry(0.7, 0.6, 10)), red).translateX(LH.x).translateY(top + 1.2).translateZ(LH.z));
  // keeper's hut
  const hut = new THREE.Group();
  hut.position.set(-1.35, LH.y0, 1.0);
  hut.add(box(1.6, 1.0, 1.25, toon(0xf0e4c8), 0, 0.5, 0));
  const roofShape = new THREE.Shape([new THREE.Vector2(-0.85, 0), new THREE.Vector2(0.85, 0), new THREE.Vector2(0, 0.75)]);
  const roof = new THREE.Mesh(new THREE.ExtrudeGeometry(roofShape, { depth: 1.9, bevelEnabled: false }).translate(0, 0, -0.95).rotateY(Math.PI / 2), toon(0x4f6f8f));
  roof.position.y = 1.0;
  hut.add(roof);
  hut.add(box(0.4, 0.7, 0.06, toon(0x6b4a2f), -0.35, 0.35, 0.65));
  const hutGlass = toon(0x34405a, { emissive: new THREE.Color(0xffc56e), emissiveIntensity: 0 });
  hut.add(box(0.42, 0.36, 0.06, hutGlass, 0.35, 0.55, 0.65));
  hut.add(box(0.06, 0.36, 0.42, hutGlass, 0.83, 0.55, 0));
  islet.add(hut);
  // dock reaching out toward the boat lane
  const wood = toon(0x8a6a4a);
  const dock = new THREE.Group();
  dock.position.set(ISLET.r - 0.4, 0.32, 0.7);
  for (let i = 0; i < 11; i++) dock.add(box(0.24, 0.07, 1.0, wood, i * 0.29, 0, 0));
  for (const px of [0.4, 1.6, 2.8]) for (const pz of [-0.45, 0.45]) dock.add(cyl(0.07, 0.07, 1.6, 6, wood, px, -0.6, pz));
  islet.add(dock);
  frame.add(shadowed(islet));

  const lampWorld = new THREE.Vector3(ISLET.x + LH.x, top + 0.52, ISLET.z + LH.z);
  const lampLight = new THREE.PointLight(0xffd88a, 0, 16, 2);
  lampLight.position.copy(lampWorld);
  root.add(lampLight);
  // The beam is NOT on `frame`: a 10-unit cone would blow up the framing.
  const beam = new THREE.Group();
  beam.position.copy(lampWorld);
  // Light falls off along the beam and is ordered-dithered, so it reads as pixel art
  // with no hard end ring.
  const BEAM_LEN = 11;
  const beamMat = new THREE.ShaderMaterial({
    uniforms: { uA: { value: 0 }, uColor: { value: new THREE.Color(0xfff0b8) } },
    vertexShader: `varying float vAlong; void main() { vAlong = position.x / ${BEAM_LEN.toFixed(1)}; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `uniform float uA; uniform vec3 uColor; varying float vAlong;
      float bayer2(vec2 a) { a = floor(a); return fract(dot(a, vec2(0.5, a.y * 0.75))); }
      float bayer4(vec2 a) { return bayer2(0.5 * a) * 0.25 + bayer2(a); }
      void main() {
        float a = uA * pow(1.0 - clamp(vAlong, 0.0, 1.0), 1.6);
        a = floor(a * 6.0 + bayer4(gl_FragCoord.xy)) / 6.0;
        gl_FragColor = vec4(uColor * a, 1.0);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  beam.add(new THREE.Mesh(new THREE.ConeGeometry(1.6, BEAM_LEN, 16, 1, true).rotateZ(Math.PI / 2).translate(BEAM_LEN / 2, 0, 0), beamMat));
  beam.renderOrder = 2;
  root.add(beam);

  // ---------- boats ----------
  const hullShape = (len, wid) => new THREE.Shape([
    new THREE.Vector2(-len / 2, -wid / 2), new THREE.Vector2(len * 0.25, -wid / 2), new THREE.Vector2(len / 2, 0),
    new THREE.Vector2(len * 0.25, wid / 2), new THREE.Vector2(-len / 2, wid / 2),
  ]);
  const hullGeo = (len, wid, h) => new THREE.ExtrudeGeometry(hullShape(len, wid), { depth: h, bevelEnabled: false }).rotateX(-Math.PI / 2);
  const sail = (pts, mat) => {
    const g = new THREE.ExtrudeGeometry(new THREE.Shape(pts.map(([a, b]) => new THREE.Vector2(a, b))), { depth: 0.04, bevelEnabled: false }).translate(0, 0, -0.02);
    return new THREE.Mesh(g, mat);
  };
  const boat = new THREE.Group();
  const boatBody = new THREE.Group();
  boatBody.rotation.x = 0.07; // a little heel in the breeze
  boatBody.add(new THREE.Mesh(hullGeo(2.2, 0.85, 0.45), toon(0xf4efe4)).translateY(-0.2));
  boatBody.add(new THREE.Mesh(hullGeo(2.25, 0.88, 0.1), toon(0x2f5d8a)).translateY(-0.22));
  boatBody.add(box(0.7, 0.25, 0.5, toon(0xc9a77a), -0.45, 0.32, 0));
  boatBody.add(cyl(0.045, 0.055, 2.6, 6, toon(0x7a5a40), 0.15, 1.5, 0));
  const canvas = toon(0xfbf7ee);
  const main = sail([[0, 0.45], [0, 2.65], [-1.15, 0.45]], canvas);
  main.position.x = 0.12;
  const jib = sail([[0, 2.4], [0, 0.4], [0.95, 0.4]], canvas);
  jib.position.x = 0.2;
  boatBody.add(main, jib, box(0.22, 0.12, 0.02, toon(0xd84b3c), 0.04, 2.82, 0));
  boat.add(boatBody);
  boat.rotation.order = 'YXZ';
  boat.scale.setScalar(1.4);
  root.add(shadowed(boat));

  const rowboat = new THREE.Group();
  rowboat.add(new THREE.Mesh(hullGeo(1.2, 0.5, 0.25), toon(0x9a6a44)).translateY(-0.1));
  rowboat.add(box(0.12, 0.04, 0.46, toon(0x7a5236), 0.1, 0.16, 0));
  rowboat.rotation.order = 'YXZ';
  const ROW = { x: ISLET.x + ISLET.r + 2.2, z: ISLET.z + 0.7 - 0.95, yaw: -0.15 };
  root.add(shadowed(rowboat));

  const buoy = new THREE.Group();
  buoy.add(cyl(0.22, 0.3, 0.45, 8, red, 0, 0.05, 0), cyl(0.2, 0.22, 0.25, 8, white, 0, 0.4, 0));
  const buoyLamp = toon(0x553333, { emissive: new THREE.Color(0xff6a5a), emissiveIntensity: 0 });
  buoy.add(box(0.12, 0.14, 0.12, buoyLamp, 0, 0.6, 0));
  const BUOY = { x: 5.6, z: 7.2 };
  root.add(shadowed(buoy));

  // Ride the surface: height from the wave, pitch and roll from its slope.
  function ride(obj, x, z, yaw, t, sink, tilt = 1) {
    const e = 0.45, fx = Math.cos(yaw), fz = -Math.sin(yaw);
    const pitch = Math.atan((waveH(x + fx * e, z + fz * e, t) - waveH(x - fx * e, z - fz * e, t)) / (2 * e));
    const sx = Math.sin(yaw), sz = Math.cos(yaw);
    const roll = -Math.atan((waveH(x + sx * e, z + sz * e, t) - waveH(x - sx * e, z - sz * e, t)) / (2 * e));
    obj.position.set(x, waveH(x, z, t) - sink, z);
    obj.rotation.set(roll * tilt, yaw, pitch * tilt);
  }

  // Lap: an ellipse round the open water, long axis across the screen. One lap = 4 min.
  const LAP = { cx: 3.3, cz: 3.3, a: 5.8, b: 2.8, period: 240 };
  const U = [0.7071, -0.7071], V = [0.7071, 0.7071];
  const lapAt = th => [LAP.cx + U[0] * LAP.a * Math.cos(th) + V[0] * LAP.b * Math.sin(th), LAP.cz + U[1] * LAP.a * Math.cos(th) + V[1] * LAP.b * Math.sin(th)];

  // ---------- gulls ----------
  function makeGull() {
    const g = new THREE.Group();
    const wht = toon(0xfafafa), gry = toon(0xb9c0c8);
    g.add(box(0.5, 0.15, 0.17, wht), box(0.16, 0.14, 0.14, wht, 0.3, 0.05, 0), box(0.1, 0.04, 0.05, toon(0xf0a030), 0.42, 0.04, 0), box(0.16, 0.05, 0.16, gry, -0.3, 0.02, 0));
    const wings = [1, -1].map(side => {
      const p = new THREE.Group();
      p.position.z = side * 0.08;
      p.add(box(0.28, 0.03, 0.75, gry, 0, 0, side * 0.375));
      g.add(p);
      return { p, side };
    });
    return { g, wings };
  }
  const gulls = [[7.5, 5.6, 0.14, 0], [6.2, 6.4, -0.11, 2.2], [8.4, 5.0, 0.12, 4.1]].map(([r, alt, w, ph]) => {
    const gull = makeGull();
    root.add(gull.g);
    return Object.assign(gull, { r, alt, w, ph, flapFor: 0, nextFlap: 3 + R2() * 8 });
  });

  // ---------- fish ----------
  const SCHOOLS = [
    // Kept near the two glass sides that face the camera: deeper in, you'd only see them through the surface.
    { cx: 6.2, cz: 3.0, ax: 2.6, az: 4.6, y: -2.0, w: 0.11, n: 8, col: 0xff8a36 },
    { cx: 3.0, cz: 6.4, ax: 4.6, az: 2.4, y: -3.0, w: -0.09, n: 9, col: 0xb8d4ec },
    { cx: 6.4, cz: 6.4, ax: 2.4, az: 2.4, y: -4.0, w: 0.13, n: 7, col: 0xffd84a },
  ];
  const fishN = SCHOOLS.reduce((n, s) => n + s.n, 0);
  const fishBody = new THREE.InstancedMesh(new THREE.BoxGeometry(0.5, 0.21, 0.15), toon(0xffffff), fishN);
  const fishTail = new THREE.InstancedMesh(new THREE.BoxGeometry(0.15, 0.2, 0.04), toon(0xffffff), fishN);
  const fish = [];
  SCHOOLS.forEach(s => {
    const a = R() * 6.28, b = R() * 6.28;
    for (let i = 0; i < s.n; i++) {
      fish.push({ s, a, b, dx: (R() - 0.5) * 1.4, dy: (R() - 0.5) * 0.6, dz: (R() - 0.5) * 1.4, ph: R() * 6.28 });
      fishBody.setColorAt(fish.length - 1, col.set(s.col).offsetHSL(0, 0, (R() - 0.5) * 0.08));
      fishTail.setColorAt(fish.length - 1, col.set(s.col).offsetHSL(0, 0, -0.1));
    }
  });
  root.add(fishBody, fishTail);
  const schoolAt = (f, t) => [f.s.cx + f.s.ax * Math.sin(f.s.w * t + f.a), f.s.cz + f.s.az * Math.sin(f.s.w * 0.8 * t + f.b)];

  // ---------- bubbles ----------
  const BUB = 14;
  const bubbles = new THREE.InstancedMesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), toon(0xdff6ff), BUB);
  const bub = Array.from({ length: BUB }, () => {
    const [x, z] = kelpPts[Math.floor(R() * kelpPts.length)];
    return { x, z, y: -DEPTH + R() * DEPTH, v: 0.3 + R() * 0.15, ph: R() * 6.28 };
  });
  root.add(bubbles);

  // ---------- night plankton ----------
  const PL = 70;
  const plPos = new Float32Array(PL * 3), plCol = new Float32Array(PL * 3);
  const plMeta = [];
  while (plMeta.length < PL) {
    const x = (R() - 0.5) * (SIZE - 1), z = (R() - 0.5) * (SIZE - 1);
    if (Math.hypot(x - ISLET.x, z - ISLET.z) > ISLET.r + 1) plMeta.push({ x, z, y: -DEPTH + 0.4 + R() * (DEPTH - 0.8), a: R() * 6.28, w: 0.7 + R() * 0.6, ph: R() * 6.28 });
  }
  const plGeo = new THREE.BufferGeometry();
  plGeo.setAttribute('position', new THREE.BufferAttribute(plPos, 3));
  plGeo.setAttribute('color', new THREE.BufferAttribute(plCol, 3));
  const plankton = new THREE.Points(plGeo, new THREE.PointsMaterial({ size: 1, sizeAttenuation: false, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  plankton.frustumCulled = false;
  plankton.renderOrder = 0;
  root.add(plankton);

  // ---------- clouds (same scheme as the countryside) ----------
  const WIND = new THREE.Vector3(0.7071, 0, -0.7071), PERP = new THREE.Vector3(0.7071, 0, 0.7071);
  const cloudMat = toon(0xffffff);
  const ghostMat = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });
  const makeCloud = (mat, scale) => {
    const g = new THREE.Group();
    const n = 3 + Math.floor(R() * 3);
    for (let i = 0; i < n; i++) {
      const w = (1.6 + R() * 2.0) * scale;
      g.add(box(w, (0.7 + R() * 0.8) * scale, w * (0.6 + R() * 0.4), mat, (i - n / 2) * 1.25 * scale + R() * 0.6, R() * 0.5 * scale, (R() - 0.5) * 1.6 * scale));
    }
    return g;
  };
  const clouds = [
    [-18, -4.5, 8.5, 0.2, true], [6, -3.0, -6, 0.17, true], [20, -7.5, -11, 0.23, true], [-4, -9, 4, 0.19, true],
  ].map(([s, alt, lat, v, visible]) => {
    const g = makeCloud(visible ? cloudMat : ghostMat, visible ? 1 : 1.4);
    g.traverse(c => { if (c.isMesh) c.castShadow = !visible; });
    root.add(g);
    return { g, s, alt, lat, v };
  });

  // ---------- per frame ----------
  const q = new THREE.Quaternion(), e = new THREE.Euler(), v3 = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1);
  function update(dt, t) {
    const night = world.night, evening = world.evening;
    lamp.emissiveIntensity = night * 2.2;
    hutGlass.emissiveIntensity = night * 1.6;
    lampLight.intensity = night * 14;
    beamMat.uniforms.uA.value = evening * 0.32;
    beam.visible = evening > 0.01;
    beam.rotation.y = -t * (Math.PI * 2 / 16);
    buoyLamp.emissiveIntensity = night * Math.max(0, Math.sin(t * Math.PI * 2 / 4)) ** 4 * 2.5;

    const th = (t / LAP.period) * Math.PI * 2;
    const [bx, bz] = lapAt(th);
    const [nx, nz] = lapAt(th + 0.01);
    ride(boat, bx, bz, Math.atan2(-(nz - bz), nx - bx), t, 0.05, 1.3);
    ride(rowboat, ROW.x + Math.sin(t * 0.21) * 0.08, ROW.z, ROW.yaw + Math.sin(t * 0.17) * 0.06, t, 0.02, 1.5);
    ride(buoy, BUOY.x, BUOY.z, 0, t, 0.12, 1.8);

    for (const gl of gulls) {
      const a = gl.ph + gl.w * t;
      gl.g.visible = evening < 0.5;
      gl.g.position.set(1.5 + gl.r * Math.cos(a), gl.alt + Math.sin(t * 0.31 + gl.ph) * 0.3, 1.5 + gl.r * Math.sin(a));
      const vx = -Math.sin(a) * gl.w, vz = Math.cos(a) * gl.w;
      gl.g.rotation.set(Math.sign(gl.w) * -0.28, Math.atan2(-vz, vx), 0, 'YXZ');
      gl.nextFlap -= dt;
      if (gl.nextFlap <= 0) { gl.flapFor = 1.6 + R2() * 1.2; gl.nextFlap = 8 + R2() * 10; }
      gl.flapFor = Math.max(0, gl.flapFor - dt);
      const flap = gl.flapFor > 0 ? Math.sin(t * 6) * 0.55 : 0.14;
      for (const w of gl.wings) w.p.rotation.x = -w.side * flap;
    }

    fish.forEach((fi, i) => {
      const [lx, lz] = schoolAt(fi, t), [mx, mz] = schoolAt(fi, t + 0.2);
      const x = lx + fi.dx + Math.sin(t * 0.5 + fi.ph) * 0.15, z = lz + fi.dz + Math.cos(t * 0.4 + fi.ph) * 0.15;
      const yy = fi.s.y + fi.dy + Math.sin(t * 0.6 + fi.ph) * 0.08;
      const yaw = Math.atan2(-(mz - lz), mx - lx);
      q.setFromEuler(e.set(0, yaw, 0));
      fishBody.setMatrixAt(i, m4.compose(v3.set(x, yy, z), q, one));
      const wag = Math.sin(t * 3 + fi.ph) * 0.4;
      q.setFromEuler(e.set(0, yaw + wag, 0));
      fishTail.setMatrixAt(i, m4.compose(v3.set(x - Math.cos(yaw) * 0.31, yy, z + Math.sin(yaw) * 0.31), q, one));
    });
    fishBody.instanceMatrix.needsUpdate = fishTail.instanceMatrix.needsUpdate = true;

    bub.forEach((b, i) => {
      b.y += b.v * dt;
      if (b.y > -0.15) { b.y = -DEPTH + 0.1; [b.x, b.z] = kelpPts[Math.floor(R2() * kelpPts.length)]; }
      bubbles.setMatrixAt(i, m4.makeTranslation(b.x + Math.sin(t * 1.3 + b.ph) * 0.08, b.y, b.z + Math.cos(t * 1.1 + b.ph) * 0.08));
    });
    bubbles.instanceMatrix.needsUpdate = true;

    plankton.visible = evening > 0.01;
    if (plankton.visible) {
      plankton.material.size = world.pointSize ?? 1;
      plMeta.forEach((p, i) => {
        plPos[i * 3] = p.x + Math.sin(t * 0.13 + p.a) * 0.6;
        plPos[i * 3 + 1] = p.y + Math.sin(t * 0.21 + p.a) * 0.25;
        plPos[i * 3 + 2] = p.z + Math.cos(t * 0.11 + p.a) * 0.6;
        const glow = Math.max(0, Math.sin(t * p.w + p.ph)) ** 2 * evening;
        plCol[i * 3] = glow * 0.3; plCol[i * 3 + 1] = glow; plCol[i * 3 + 2] = glow * 0.85;
      });
      plGeo.attributes.position.needsUpdate = plGeo.attributes.color.needsUpdate = true;
    }

    const span = Math.max(-world.camera.left, world.camera.right) + 8;
    for (const c of clouds) {
      c.s += dt * c.v;
      if (c.s > span) c.s -= span * 2;
      c.g.position.copy(WIND).multiplyScalar(c.s).addScaledVector(PERP, c.lat).setY(c.alt);
    }
  }
  update(0, 0);

  return {
    root,
    update,
    frame,
  };
}
