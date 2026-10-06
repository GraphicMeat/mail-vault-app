// Town: a floating old-town island. Pastel gabled houses round a cobbled square,
// a fountain, a clock tower that tells the session's time of day, people
// strolling slow laps, pigeons, a cafe, a little park and a hot-air balloon
// drifting behind. After dusk windows light up one by one, lamps and cafe
// string lights glow. Every loop runs on a 5s+ period.
export function createScene(world) {
  const { THREE, toon, flat, clamp01 } = world;
  const R = world.rng(77);
  const R2 = world.rng(9001);
  const root = new THREE.Group();
  // Everything static lives on `frame`: the world measures it to frame the shot.
  const frame = new THREE.Group();
  root.add(frame);
  const SIZE = 20, H = SIZE / 2;
  const C = { x: 1.5, z: 1.5 }; // square / fountain centre
  const WIND = new THREE.Vector3(0.7071, 0, -0.7071), PERP = new THREE.Vector3(0.7071, 0, 0.7071);

  const shadowed = o => { o.traverse(c => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; } }); return o; };
  const box = (w, h, d, mat, x = 0, y = 0, z = 0) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); m.position.set(x, y, z); return m; };
  const cyl = (rt, rb, h, seg, mat, x = 0, y = 0, z = 0) => { const m = new THREE.Mesh(flat(new THREE.CylinderGeometry(rt, rb, h, seg)), mat); m.position.set(x, y, z); return m; };
  const m4 = new THREE.Matrix4(), col = new THREE.Color();
  const mats = {};
  const mat = c => (mats[c] ??= toon(c));

  // ---------- ground ----------
  const isPark = (x, z) => x + z > 12.4;
  const tiles = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.16, 1).translate(0, -0.08, 0), toon(0xffffff), SIZE * SIZE);
  let k = 0;
  for (let i = 0; i < SIZE; i++) for (let j = 0; j < SIZE; j++) {
    const x = -H + i + 0.5, z = -H + j + 0.5;
    const ring = Math.max(Math.abs(x - C.x), Math.abs(z - C.z));
    if (isPark(x, z) || x > 9 || z > 9) col.set(0x7cbc52).offsetHSL((R() - 0.5) * 0.02, 0, (R() - 0.5) * 0.05);
    else if (ring < 4.6) col.set(Math.floor(ring) % 2 ? 0xb3aa9b : 0xa39a8c).offsetHSL(0, 0, (R() - 0.5) * 0.03);
    else col.set(0xa8a094).offsetHSL(0, 0, (R() - 0.5) * 0.05);
    tiles.setMatrixAt(k, m4.makeTranslation(x, 0, z));
    tiles.setColorAt(k++, col);
  }
  tiles.receiveShadow = true;
  frame.add(tiles);
  let y = -0.16;
  for (const [s, h, c] of [[SIZE, 1.3, 0x8a5a3c], [SIZE - 1.4, 1.7, 0x7f7b89], [SIZE - 4, 1.7, 0x6d6a79], [SIZE - 8, 1.5, 0x5e5b6a], [SIZE - 12.5, 1.2, 0x504d5c]]) {
    const layer = box(s, h, s, mat(c), 0, y - h / 2, 0);
    layer.receiveShadow = true;
    frame.add(layer);
    y -= h;
  }

  // ---------- houses ----------
  // Windows are one instanced mesh, recoloured per frame: dark glass by day, and
  // after dusk each one lights at its own moment.
  const winLocal = [];
  const chimneys = [];
  const WALLS = [0xf3d98b, 0xf2b8a8, 0xbfe0c6, 0xf4ece0, 0xb9d3ea, 0xe8c3dd, 0xf7c97c];
  const ROOFS = [0xb4553d, 0xa8483a, 0xc0653e, 0x8e4a3a];
  function house(cx, cz, W, D, h, wall, roof, alongZ, chimney) {
    const g = new THREE.Group();
    g.position.set(cx, 0, cz);
    if (alongZ) g.rotation.y = Math.PI / 2; // local front (+z) faces +x
    g.add(box(W, h, D, mat(wall), 0, h / 2, 0));
    const rh = 0.9 + W * 0.22;
    const shape = new THREE.Shape([new THREE.Vector2(-(D + 0.5) / 2, 0), new THREE.Vector2((D + 0.5) / 2, 0), new THREE.Vector2(0, rh)]);
    const r = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: W + 0.08, bevelEnabled: false }).translate(0, 0, -(W + 0.08) / 2).rotateY(Math.PI / 2), mat(roof));
    r.position.y = h;
    g.add(r);
    // trim band between floors
    g.add(box(W + 0.04, 0.1, D + 0.04, mat(0xe9e2d4), 0, 1.05, 0));
    const cols = Math.max(1, Math.floor(W / 0.85));
    const floors = Math.max(1, Math.floor((h - 0.5) / 1.1));
    const doorCol = Math.floor(cols / 2);
    for (let f = 0; f < floors; f++) for (let c = 0; c < cols; c++) {
      const lx = -W / 2 + (c + 0.5) * (W / cols);
      if (f === 0 && c === doorCol) { g.add(box(0.48, 0.85, 0.06, mat(0x6b4a2f), lx, 0.43, D / 2 + 0.03)); continue; }
      winLocal.push({ g, x: lx, y: 0.62 + f * 1.1, z: D / 2 + 0.03, on: R() < 0.82 ? 0.08 + R() * 0.8 : 2 });
    }
    if (chimney) {
      g.add(box(0.36, 1.0, 0.36, mat(0x9a8f88), W * 0.25, h + rh * 0.55, -D * 0.18));
      chimneys.push({ g, local: new THREE.Vector3(W * 0.25, h + rh * 0.55 + 0.55, -D * 0.18) });
    }
    frame.add(shadowed(g));
    return g;
  }
  // back-right row: along x, fronts face +z
  const rowX = [[-5, -2.6, 3.4], [-2.6, -0.3, 4.4], [-0.3, 2.3, 3.6], [2.3, 4.9, 4.8], [4.9, 7.4, 3.2], [7.4, 9.6, 4.0]];
  rowX.forEach(([a, b, h], i) => house((a + b) / 2, -8, b - a, 3, h, WALLS[i % WALLS.length], ROOFS[i % ROOFS.length], false, i === 1 || i === 3));
  // back-left row: along z, fronts face +x
  const rowZ = [[-5, -2.5, 4.2], [-2.5, 0, 3.4], [0, 2.4, 4.6], [2.4, 5, 3.6], [5, 7.4, 4.0], [7.4, 9.6, 3.2]];
  rowZ.forEach(([a, b, h], i) => house(-8, (a + b) / 2, b - a, 3, h, WALLS[(i + 3) % WALLS.length], ROOFS[(i + 2) % ROOFS.length], true, i === 2));

  frame.updateMatrixWorld(true);
  const windows = new THREE.InstancedMesh(new THREE.BoxGeometry(0.4, 0.52, 0.06), new THREE.MeshBasicMaterial({ color: 0xffffff }), winLocal.length);
  winLocal.forEach((w, i) => windows.setMatrixAt(i, m4.copy(w.g.matrixWorld).multiply(new THREE.Matrix4().makeTranslation(w.x, w.y, w.z))));
  frame.add(windows);
  const GLASS = new THREE.Color(0x46577a), LIT = new THREE.Color(0xffd27a), tmpC = new THREE.Color();

  // ---------- clock tower ----------
  const tower = new THREE.Group();
  tower.position.set(-8, 0, -8);
  tower.add(box(2.7, 0.5, 2.7, mat(0x9b958c), 0, 0.25, 0));
  tower.add(box(2.4, 6.8, 2.4, mat(0xefe2c4), 0, 3.9, 0));
  tower.add(box(2.6, 0.18, 2.6, mat(0xd8c9a8), 0, 4.2, 0));
  tower.add(box(2.6, 0.18, 2.6, mat(0xd8c9a8), 0, 7.3, 0));
  for (const [x, z, w, d] of [[1.21, 0, 0.04, 0.9], [0, 1.21, 0.9, 0.04]]) tower.add(box(w, 1.3, d, mat(0x2e2a33), x, 6.3, z)); // belfry
  tower.add(new THREE.Mesh(flat(new THREE.ConeGeometry(1.95, 2.6, 4).rotateY(Math.PI / 4)), mat(0x5f9e8a)).translateY(8.6));
  tower.add(cyl(0.035, 0.035, 1.2, 4, mat(0x3b3a40), 0, 10.4, 0));
  const flag = new THREE.Group();
  flag.position.set(0, 10.75, 0);
  for (let i = 0; i < 4; i++) flag.add(box(0.16, 0.3, 0.03, mat(i % 2 ? 0xd84b3c : 0xf3d35b), 0.1 + i * 0.16, 0, 0));
  tower.add(flag);
  const hands = [];
  for (const ry of [0, Math.PI / 2]) { // +z face, +x face
    const face = new THREE.Group();
    face.rotation.y = ry;
    face.position.set(Math.sin(ry) * 1.22, 5.05, Math.cos(ry) * 1.22);
    face.add(new THREE.Mesh(new THREE.CylinderGeometry(0.66, 0.66, 0.05, 16).rotateX(Math.PI / 2), mat(0x3b3a40)));
    face.add(new THREE.Mesh(new THREE.CylinderGeometry(0.56, 0.56, 0.06, 16).rotateX(Math.PI / 2), mat(0xfbf7ee)));
    const hour = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.32, 0.03).translate(0, 0.16, 0.05), mat(0x2b2b30));
    const minute = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.48, 0.03).translate(0, 0.24, 0.07), mat(0x2b2b30));
    face.add(hour, minute);
    hands.push({ hour, minute });
    tower.add(face);
  }
  frame.add(shadowed(tower));

  // ---------- fountain ----------
  const fountain = new THREE.Group();
  fountain.position.set(C.x, 0, C.z);
  fountain.add(cyl(1.6, 1.7, 0.5, 8, mat(0xcfc6b4), 0, 0.25, 0));
  fountain.add(cyl(1.38, 1.38, 0.06, 8, mat(0x4aa6c8), 0, 0.44, 0));
  fountain.add(cyl(0.22, 0.3, 1.2, 8, mat(0xcfc6b4), 0, 0.85, 0));
  fountain.add(cyl(0.6, 0.32, 0.22, 8, mat(0xcfc6b4), 0, 1.4, 0));
  fountain.add(cyl(0.5, 0.5, 0.04, 8, mat(0x4aa6c8), 0, 1.5, 0));
  frame.add(shadowed(fountain));
  const DROPS = 32, LIFE = 1.38;
  const drops = new THREE.InstancedMesh(new THREE.BoxGeometry(0.08, 0.1, 0.08), toon(0xbfe8f5), DROPS);
  const dropMeta = Array.from({ length: DROPS }, (_, i) => ({ a: (i / DROPS) * Math.PI * 2 + R() * 0.2, age: (i * 0.37) % LIFE }));
  root.add(drops);

  // ---------- lamps ----------
  const lampMat = toon(0x3a3a40, { emissive: new THREE.Color(0xffd27a), emissiveIntensity: 0 });
  const lampLights = [];
  for (const [x, z] of [[C.x - 4.1, C.z - 4.1], [C.x + 4.1, C.z - 4.1], [C.x - 4.1, C.z + 4.1], [C.x + 4.1, C.z + 4.1]]) {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.add(cyl(0.06, 0.08, 1.9, 6, mat(0x2f3036), 0, 0.95, 0), box(0.26, 0.3, 0.26, lampMat, 0, 2.0, 0), box(0.34, 0.06, 0.34, mat(0x2f3036), 0, 2.18, 0));
    frame.add(shadowed(g));
    const l = new THREE.PointLight(0xffc670, 0, 5.5, 2);
    l.position.set(x, 1.7, z);
    root.add(l);
    lampLights.push(l);
  }

  // ---------- cafe ----------
  const cafeX = (rowX[4][0] + rowX[4][1]) / 2, cafeZ = -6.5;
  const awning = new THREE.Group();
  awning.position.set(cafeX, 2.05, cafeZ + 0.62);
  awning.rotation.x = 0.35;
  for (let i = 0; i < 8; i++) awning.add(box(0.3, 0.05, 1.3, mat(i % 2 ? 0xf4ece0 : 0xc8463c), -1.05 + i * 0.3, 0, 0));
  frame.add(shadowed(awning));
  for (const [x, z, c] of [[cafeX - 0.7, -4.6, 0xc8463c], [cafeX + 0.9, -4.3, 0x3f7f9a], [cafeX + 2.2, -5.2, 0xc8463c]]) {
    const t = new THREE.Group();
    t.position.set(x, 0, z);
    t.add(cyl(0.3, 0.3, 0.05, 8, mat(0xf4ece0), 0, 0.55, 0), cyl(0.04, 0.04, 0.55, 4, mat(0x3b3a40), 0, 0.27, 0));
    t.add(cyl(0.03, 0.03, 1.1, 4, mat(0x3b3a40), 0, 1.0, 0), new THREE.Mesh(flat(new THREE.ConeGeometry(0.75, 0.32, 8)), mat(c)).translateY(1.6));
    for (const a of [0.4, 2.5, 4.4]) t.add(box(0.22, 0.3, 0.22, mat(0x7a5236), Math.cos(a) * 0.5, 0.15, Math.sin(a) * 0.5));
    frame.add(shadowed(t));
  }
  // string lights: awning corner -> lamp -> other corner
  const strand = [];
  const sag = (a, b, n, dip) => { for (let i = 0; i <= n; i++) { const u = i / n; strand.push(new THREE.Vector3().lerpVectors(a, b, u).setY(a.y + (b.y - a.y) * u - Math.sin(u * Math.PI) * dip)); } };
  sag(new THREE.Vector3(cafeX - 1.2, 2.3, cafeZ + 1.1), new THREE.Vector3(C.x + 4.1, 2.1, C.z - 4.1), 14, 0.35);
  sag(new THREE.Vector3(C.x + 4.1, 2.1, C.z - 4.1), new THREE.Vector3(cafeX + 1.2, 2.3, cafeZ + 1.1), 10, 0.3);
  const bulbPos = new Float32Array(strand.length * 3), bulbCol = new Float32Array(strand.length * 3);
  strand.forEach((p, i) => bulbPos.set([p.x, p.y, p.z], i * 3));
  const bulbGeo = new THREE.BufferGeometry();
  bulbGeo.setAttribute('position', new THREE.BufferAttribute(bulbPos, 3));
  bulbGeo.setAttribute('color', new THREE.BufferAttribute(bulbCol, 3));
  const bulbs = new THREE.Points(bulbGeo, new THREE.PointsMaterial({ size: 1, sizeAttenuation: false, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  bulbs.frustumCulled = false;
  root.add(bulbs);

  // ---------- park, market, trees ----------
  function tree(x, z, s) {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.add(box(0.3 * s, 1.2 * s, 0.3 * s, mat(0x7a5236), 0, 0.6 * s, 0));
    const a = new THREE.Mesh(new THREE.IcosahedronGeometry(1.0 * s, 0), mat(0x4f9a45)); a.position.y = 1.9 * s;
    const b = new THREE.Mesh(new THREE.IcosahedronGeometry(0.62 * s, 0), mat(0x66b052)); b.position.set(0.3 * s, 2.6 * s, -0.2 * s);
    g.add(a, b);
    frame.add(shadowed(g));
  }
  for (const [x, z, s] of [[8.4, 6.6, 0.95], [6.6, 8.6, 0.85], [9.0, 9.0, 0.7], [8.6, -1.2, 0.8], [8.7, 2.6, 0.75], [-5.4, 8.8, 0.8]]) tree(x, z, s);
  function bench(x, z, ry) {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.rotation.y = ry;
    g.add(box(1.1, 0.08, 0.36, mat(0x8a6a4a), 0, 0.42, 0), box(1.1, 0.34, 0.07, mat(0x8a6a4a), 0, 0.68, -0.16));
    for (const lx of [-0.45, 0.45]) g.add(box(0.07, 0.42, 0.3, mat(0x2f3036), lx, 0.21, 0));
    frame.add(shadowed(g));
    return g;
  }
  bench(7.4, 5.6, -Math.PI * 0.75);
  const parkBench = bench(5.7, 7.6, -Math.PI * 0.75);
  bench(8.6, 0.7, -Math.PI / 2);
  for (let i = 0; i < 26; i++) {
    const u = R(), v = R();
    const x = 6.2 + u * 3.4, z = 9.6 - v * (x + 0 > 0 ? 3.4 : 0);
    if (!isPark(x, z) || Math.hypot(x - 8.4, z - 6.6) < 0.8 || Math.hypot(x - 6.6, z - 8.6) < 0.8) continue;
    frame.add(box(0.14, 0.14, 0.14, mat([0xfffbf0, 0xffe066, 0xf6a6c8, 0xc6a8f0, 0xff9a7a][i % 5]), x, 0.12, z));
  }
  // sitting reader on the park bench
  const reader = new THREE.Group();
  parkBench.add(reader);
  reader.add(box(0.28, 0.36, 0.2, mat(0x3f7f9a), 0, 0.64, -0.02), box(0.17, 0.17, 0.17, mat(0xf0c8a0), 0, 0.92, -0.02), box(0.17, 0.06, 0.17, mat(0x5a3a2a), 0, 1.02, -0.02));
  reader.add(box(0.24, 0.08, 0.2, mat(0x34405a), 0, 0.46, 0.12), box(0.2, 0.14, 0.04, mat(0xf4ece0), 0, 0.66, 0.16));
  // market stall
  const stall = new THREE.Group();
  stall.position.set(-3.6, 0, 7.8);
  stall.add(box(2.0, 0.8, 0.8, mat(0x8a6a4a), 0, 0.4, 0));
  for (const lx of [-0.95, 0.95]) for (const lz of [-0.35, 0.35]) stall.add(box(0.07, 1.9, 0.07, mat(0x7a5236), lx, 0.95, lz));
  for (let i = 0; i < 7; i++) stall.add(box(0.3, 0.05, 1.1, mat(i % 2 ? 0xf4ece0 : 0x3f8a5a), -0.9 + i * 0.3, 1.95, 0));
  for (const [lx, c] of [[-0.6, 0xf08a3c], [0, 0xd84b3c], [0.6, 0x9ccc4a]]) stall.add(box(0.5, 0.18, 0.5, mat(c), lx, 0.89, 0));
  frame.add(shadowed(stall));

  // ---------- chimney smoke ----------
  const PUFF_LIFE = 10, PUFFS = 8;
  const puffGeo = new THREE.BoxGeometry(1, 1, 1);
  const puffs = [];
  chimneys.forEach((c, ci) => {
    c.world = c.local.clone().applyMatrix4(c.g.matrixWorld);
    for (let i = 0; i < PUFFS; i++) {
      const m = new THREE.Mesh(puffGeo, toon(0xece8e2, { transparent: true, depthWrite: false }));
      root.add(m);
      puffs.push({ m, o: c.world, age: ((i + ci * 0.33) * PUFF_LIFE) / PUFFS, jx: R() - 0.5, jz: R() - 0.5, spin: (R() - 0.5) * 0.4 });
    }
  });

  // ---------- strollers ----------
  const SKIN = [0xf0c8a0, 0xd9a47a, 0xa8754f, 0xf4d2b4];
  function person(shirt, legs, hair, skin) {
    const g = new THREE.Group();
    const L = [-0.07, 0.07].map(z => { const p = new THREE.Group(); p.position.set(0, 0.34, z); p.add(box(0.09, 0.34, 0.09, mat(legs), 0, -0.17, 0)); g.add(p); return p; });
    g.add(box(0.2, 0.36, 0.28, mat(shirt), 0, 0.52, 0), box(0.17, 0.17, 0.17, mat(skin), 0, 0.8, 0), box(0.18, 0.06, 0.18, mat(hair), -0.01, 0.9, 0));
    return { g: shadowed(g), legs: L };
  }
  const walkers = [[2.5, 0.32, 1, 0xd84b3c, 0x2f3a5a], [2.9, 0.27, -1, 0x3f8a5a, 0x4a3a2a], [3.3, 0.36, 1, 0xf3d35b, 0x34405a], [3.7, 0.3, -1, 0x9a6ab0, 0x2f3036]].map(([hs, v, dir, shirt, legs], i) => {
    const p = person(shirt, legs, [0x3a2a1a, 0x8a5a2a, 0x1a1a1a, 0xc8a050][i], SKIN[i]);
    root.add(p.g);
    return Object.assign(p, { hs, v, dir, s: R() * 8 * hs, pause: 0, nextPause: 6 + R2() * 14, phase: 0, yaw: 0 });
  });
  const ringAt = (hs, s) => {
    const side = Math.floor(s / (2 * hs)) % 4, u = (s % (2 * hs)) - hs;
    return [[u, -hs], [hs, u], [-u, hs], [-hs, -u]][side].map((v, i) => v + (i ? C.z : C.x));
  };

  // ---------- pigeons ----------
  const pigeons = Array.from({ length: 6 }, (_, i) => {
    const g = new THREE.Group();
    g.add(box(0.24, 0.13, 0.13, mat(0x8d93a0), 0, 0.12, 0), box(0.07, 0.05, 0.12, mat(0x6d7380), -0.15, 0.13, 0));
    const neck = new THREE.Group();
    neck.position.set(0.1, 0.17, 0);
    neck.add(box(0.09, 0.09, 0.09, mat(0x5f7a78), 0.04, 0.03, 0));
    g.add(neck);
    const a = (i / 6) * Math.PI * 2 + R() * 0.5, r = 1.9 + R() * 0.2; // between the basin and the inner strollers
    g.position.set(C.x + Math.cos(a) * r, 0, C.z + Math.sin(a) * r);
    g.rotation.y = R() * 6.28;
    root.add(g);
    return { g, neck, peck: R() * 3, a, r, hop: 0 };
  });

  // ---------- balloon ----------
  const balloon = new THREE.Group();
  const envMats = [0xd84b3c, 0xf3d35b].map(c => toon(c, { emissive: new THREE.Color(0xff9a40), emissiveIntensity: 0 }));
  for (let i = 0; i < 8; i++) {
    const gore = new THREE.Mesh(flat(new THREE.SphereGeometry(1.2, 2, 7, (i * Math.PI) / 4, Math.PI / 4)), envMats[i % 2]);
    gore.scale.y = 1.15;
    balloon.add(gore);
  }
  balloon.add(cyl(0.45, 0.25, 0.4, 8, envMats[0], 0, -1.35, 0), box(0.4, 0.3, 0.4, mat(0x8a6a4a), 0, -2.0, 0));
  for (const [x, z] of [[0.18, 0.18], [-0.18, 0.18], [0.18, -0.18], [-0.18, -0.18]]) balloon.add(box(0.02, 0.5, 0.02, mat(0x3b3a40), x, -1.65, z));
  root.add(balloon);
  const BAL = { s: -6, alt: 4.2, lat: -13, burn: 0, next: 4 };

  // ---------- clouds (same scheme as the countryside) ----------
  const cloudMat = toon(0xffffff);
  const ghostMat = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });
  const makeCloud = (m, scale) => {
    const g = new THREE.Group();
    const n = 3 + Math.floor(R() * 3);
    for (let i = 0; i < n; i++) {
      const w = (1.6 + R() * 2.0) * scale;
      g.add(box(w, (0.7 + R() * 0.8) * scale, w * (0.6 + R() * 0.4), m, (i - n / 2) * 1.25 * scale + R() * 0.6, R() * 0.5 * scale, (R() - 0.5) * 1.6 * scale));
    }
    return g;
  };
  const clouds = [
    [-18, -2.2, 8.5, 0.2, true], [6, -1.4, -6, 0.17, true], [20, -4.5, -11, 0.23, true], [-4, -5.5, 4, 0.19, true],
    [-10, 14, 1, 0.3, false], [12, 14, -4, 0.3, false],
  ].map(([s, alt, lat, v, visible]) => {
    const g = makeCloud(visible ? cloudMat : ghostMat, visible ? 1 : 1.4);
    g.traverse(c => { if (c.isMesh) c.castShadow = !visible; });
    root.add(g);
    return { g, s, alt, lat, v };
  });

  // ---------- per frame ----------
  const v3 = new THREE.Vector3();
  function update(dt, t) {
    // Lights follow the evening fade too, so the town comes on across the whole dusk, not at full dark.
    const night = Math.max(world.night, world.evening), evening = world.evening, p = world.progress;

    // Windows: each lights at its own threshold, so the town comes on one window at a time.
    winLocal.forEach((w, i) => {
      const lit = clamp01((night - w.on) / 0.08);
      windows.setColorAt(i, tmpC.copy(GLASS).multiplyScalar(0.35 + 0.65 * (1 - night)).lerp(LIT, lit));
    });
    windows.instanceColor.needsUpdate = true;
    lampMat.emissiveIntensity = night * 2.0;
    for (const l of lampLights) l.intensity = night * 5;
    strand.forEach((_, i) => {
      const b = evening * (0.7 + 0.3 * Math.sin(t * 0.8 + i * 1.7));
      bulbCol[i * 3] = b; bulbCol[i * 3 + 1] = b * 0.82; bulbCol[i * 3 + 2] = b * 0.5;
    });
    bulbGeo.attributes.color.needsUpdate = true;
    bulbs.visible = evening > 0.01;
    bulbs.material.size = world.pointSize ?? 1;

    // Clock tells the session's day: 06:00 at the start, 22:00 at the end.
    const hours = 6 + 16 * p;
    for (const { hour, minute } of hands) { hour.rotation.z = -((hours % 12) / 12) * Math.PI * 2; minute.rotation.z = -(hours % 1) * Math.PI * 2; }
    flag.children.forEach((c, i) => { c.rotation.y = Math.sin(t * 1.2 - i * 0.6) * 0.25 * (i + 1) / 4; c.position.z = Math.sin(t * 1.2 - i * 0.6) * 0.05 * i; });

    dropMeta.forEach((d, i) => {
      d.age = (d.age + dt) % LIFE;
      const u = d.age, r = 0.55 + 0.7 * u;
      drops.setMatrixAt(i, m4.makeTranslation(C.x + Math.cos(d.a) * r, 1.45 + 1.0 * u - 1.25 * u * u, C.z + Math.sin(d.a) * r));
    });
    drops.instanceMatrix.needsUpdate = true;

    for (const pf of puffs) {
      pf.age += dt;
      if (pf.age > PUFF_LIFE) { pf.age -= PUFF_LIFE; pf.jx = R2() - 0.5; pf.jz = R2() - 0.5; }
      const u = pf.age / PUFF_LIFE;
      pf.m.position.copy(pf.o).addScaledVector(WIND, u ** 1.5 * 2.0).add(v3.set(pf.jx * 0.4 * u, u * 3.8, pf.jz * 0.4 * u));
      pf.m.scale.setScalar(0.24 + u * 0.5);
      pf.m.rotation.y = pf.spin * pf.age;
      pf.m.material.opacity = 0.8 * (1 - u) ** 1.3 * Math.min(1, u * 8);
    }

    for (const w of walkers) {
      if (w.pause > 0) w.pause -= dt;
      else {
        w.s = (w.s + w.dir * w.v * dt + 8 * w.hs) % (8 * w.hs);
        w.phase += w.v * dt * 9;
        w.nextPause -= dt;
        if (w.nextPause <= 0) { w.pause = 3 + R2() * 5; w.nextPause = 10 + R2() * 18; }
      }
      const [x, z] = ringAt(w.hs, w.s), [nx, nz] = ringAt(w.hs, (w.s + w.dir * 0.4 + 8 * w.hs) % (8 * w.hs));
      const want = w.pause > 0 ? Math.atan2(-(C.z - z), C.x - x) : Math.atan2(-(nz - z), nx - x); // pause = look at the fountain
      let d = Math.atan2(Math.sin(want - w.yaw), Math.cos(want - w.yaw));
      w.yaw += d * (1 - Math.exp(-dt * 3));
      w.g.position.set(x, Math.abs(Math.sin(w.phase)) * 0.03 * (w.pause > 0 ? 0 : 1), z);
      w.g.rotation.y = w.yaw;
      const sw = w.pause > 0 ? 0 : Math.sin(w.phase) * 0.45;
      w.legs[0].rotation.z = sw; w.legs[1].rotation.z = -sw;
    }

    for (const pg of pigeons) {
      pg.peck -= dt;
      if (pg.peck <= 0) {
        pg.peck = 1.5 + R2() * 3;
        if (R2() < 0.25) { pg.a += (R2() - 0.5) * 0.3; pg.hop = 0.5; pg.g.rotation.y += (R2() - 0.5) * 1.2; }
      }
      pg.hop = Math.max(0, pg.hop - dt);
      pg.g.position.set(C.x + Math.cos(pg.a) * pg.r, Math.sin(pg.hop * Math.PI * 2) * 0.06, C.z + Math.sin(pg.a) * pg.r);
      pg.neck.rotation.z = pg.peck < 0.5 ? -0.9 * Math.sin((pg.peck / 0.5) * Math.PI) : 0;
    }

    const span = Math.max(-world.camera.left, world.camera.right) + 8;
    BAL.s += dt * 0.15;
    if (BAL.s > span) BAL.s -= span * 2;
    balloon.position.copy(WIND).multiplyScalar(BAL.s).addScaledVector(PERP, BAL.lat).setY(BAL.alt + Math.sin(t * 0.25) * 0.3);
    BAL.next -= dt;
    if (BAL.next <= 0) { BAL.burn = 1.4; BAL.next = 7 + R2() * 6; }
    BAL.burn = Math.max(0, BAL.burn - dt);
    for (const m of envMats) m.emissiveIntensity = night * (BAL.burn > 0 ? 0.9 + 0.3 * Math.sin(t * 20) : 0.12);

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
