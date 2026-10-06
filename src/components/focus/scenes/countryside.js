// Countryside: a floating meadow island. Cottage with chimney smoke, windmill,
// wheat field, grazing sheep, drifting clouds whose shadows cross the grass,
// fireflies and lit windows after dusk. Every loop runs on a 5s+ period.
export function createScene(world) {
  const { THREE, toon, flat, swayToon, clamp01 } = world;
  const R = world.rng(7);
  const R2 = world.rng(1234);
  const root = new THREE.Group();
  // Everything static lives on `island`: the world measures it to frame the shot.
  const island = new THREE.Group();
  root.add(island);
  const SIZE = 20, H = SIZE / 2;
  const WIND = new THREE.Vector3(0.7071, 0, -0.7071); // drifts to screen-right

  const shadowed = o => { o.traverse(c => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; } }); return o; };
  const box = (w, h, d, mat, x = 0, y = 0, z = 0) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); m.position.set(x, y, z); return m; };

  // ---------- layout ----------
  const COTTAGE = { x: -4.5, z: -4.6, w: 4, d: 3.2 };
  const MILL = { x: -6.6, z: 5.2 };
  const FIELD = { x0: 2, x1: 9, z0: -9, z1: -2 };
  const MEADOW = { x0: 1.5, x1: 9.0, z0: 1.5, z1: 9.0 };
  const TREES = [
    { x: -8.5, z: -8.4, s: 1.1, kind: 'round' }, { x: -6.0, z: -8.7, s: 0.9, kind: 'pine' },
    { x: -8.7, z: -5.6, s: 1.0, kind: 'pine' }, { x: -1.0, z: -8.5, s: 0.9, kind: 'round' },
    { x: 8.6, z: -0.6, s: 0.75, kind: 'round' }, { x: -8.6, z: 8.6, s: 1.0, kind: 'pine' },
    { x: -2.6, z: 8.7, s: 0.8, kind: 'round' },
  ];
  const PATHS = [
    [[-4.0, -2.8], [-4.0, 0.3], [-2.0, 2.4], [0.8, 3.9]],
    [[-4.0, 0.3], [-6.0, 3.6]],
  ];

  const segDist = (px, pz, [ax, az], [bx, bz]) => {
    const dx = bx - ax, dz = bz - az;
    const t = clamp01(((px - ax) * dx + (pz - az) * dz) / (dx * dx + dz * dz));
    return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
  };
  const onPath = (x, z, r = 0.62) => PATHS.some(p => p.slice(1).some((b, i) => segDist(x, z, p[i], b) < r));
  const inRect = (r, x, z, m = 0) => x >= r.x0 - m && x <= r.x1 + m && z >= r.z0 - m && z <= r.z1 + m;
  const blocked = (x, z, m = 0) =>
    Math.abs(x - COTTAGE.x) < COTTAGE.w / 2 + 0.5 + m && Math.abs(z - COTTAGE.z) < COTTAGE.d / 2 + 0.5 + m
    || Math.hypot(x - MILL.x, z - MILL.z) < 1.8 + m
    || TREES.some(t => Math.hypot(x - t.x, z - t.z) < 0.9 * t.s + m)
    || onPath(x, z) || inRect(FIELD, x, z, 0.1);

  // ---------- island ----------
  const tileGeo = new THREE.BoxGeometry(1, 0.16, 1).translate(0, -0.08, 0);
  const tiles = new THREE.InstancedMesh(tileGeo, toon(0xffffff), SIZE * SIZE);
  const m4 = new THREE.Matrix4(), col = new THREE.Color();
  let k = 0;
  for (let i = 0; i < SIZE; i++) for (let j = 0; j < SIZE; j++) {
    const x = -H + i + 0.5, z = -H + j + 0.5;
    if (inRect(FIELD, x, z)) col.set(j % 2 ? 0x8a5c3a : 0x7a4f32).offsetHSL(0, 0, (R() - 0.5) * 0.03);
    else if (onPath(x, z, 0.55)) col.set(0xd9bc8c).offsetHSL(0, 0, (R() - 0.5) * 0.05);
    else col.set(0x7cbc52).offsetHSL((R() - 0.5) * 0.02, 0, (R() - 0.5) * 0.05 + (R() < 0.08 ? 0.05 : 0));
    tiles.setMatrixAt(k, m4.makeTranslation(x, 0, z));
    tiles.setColorAt(k++, col);
  }
  tiles.receiveShadow = true;
  island.add(tiles);

  let y = -0.16;
  for (const [s, h, c] of [[SIZE, 1.3, 0x8a5a3c], [SIZE - 1.4, 1.7, 0x7f7b89], [SIZE - 4, 1.7, 0x6d6a79], [SIZE - 8, 1.5, 0x5e5b6a], [SIZE - 12.5, 1.2, 0x504d5c]]) {
    const layer = box(s, h, s, toon(c), 0, y - h / 2, 0);
    layer.receiveShadow = true;
    island.add(layer);
    y -= h;
  }

  // ---------- wheat ----------
  const wheatPos = [];
  for (let z = FIELD.z0 + 0.35; z < FIELD.z1 - 0.1; z += 0.5) for (let x = FIELD.x0 + 0.25; x < FIELD.x1 - 0.1; x += 0.36)
    wheatPos.push([x + (R() - 0.5) * 0.1, z + (R() - 0.5) * 0.1, 0.8 + R() * 0.35]);
  const stalks = new THREE.InstancedMesh(new THREE.BoxGeometry(0.12, 1, 0.12).translate(0, 0.5, 0), swayToon(0xffffff, 0.14), wheatPos.length);
  const ears = new THREE.InstancedMesh(new THREE.BoxGeometry(0.19, 0.32, 0.19).translate(0, 0.16, 0), swayToon(0xffffff, 0.14), wheatPos.length);
  wheatPos.forEach(([x, z, h], i) => {
    stalks.setMatrixAt(i, m4.compose(new THREE.Vector3(x, 0, z), new THREE.Quaternion(), new THREE.Vector3(1, h, 1)));
    stalks.setColorAt(i, col.set(0xc29a45).offsetHSL(0, 0, (R() - 0.5) * 0.06));
    ears.setMatrixAt(i, m4.makeTranslation(x, h, z));
    ears.setColorAt(i, col.set(0xeacb6a).offsetHSL((R() - 0.5) * 0.02, 0, (R() - 0.5) * 0.08));
  });
  stalks.receiveShadow = ears.receiveShadow = true;
  island.add(stalks, ears);

  // ---------- grass tufts + flowers ----------
  const scatter = (n, margin) => {
    const out = [];
    for (let tries = 0; out.length < n && tries < n * 20; tries++) {
      const x = (R() - 0.5) * (SIZE - 0.6), z = (R() - 0.5) * (SIZE - 0.6);
      if (!blocked(x, z, margin)) out.push([x, z]);
    }
    return out;
  };
  const tuftPts = scatter(240, 0.1);
  const tufts = new THREE.InstancedMesh(flat(new THREE.ConeGeometry(0.11, 0.42, 4).translate(0, 0.21, 0)), swayToon(0xffffff, 0.35), tuftPts.length);
  tuftPts.forEach(([x, z], i) => {
    const s = 0.7 + R() * 0.7;
    tufts.setMatrixAt(i, m4.compose(new THREE.Vector3(x, 0, z), new THREE.Quaternion(), new THREE.Vector3(s, s, s)));
    tufts.setColorAt(i, col.set(0x5c9c3c).offsetHSL((R() - 0.5) * 0.03, 0, (R() - 0.5) * 0.06));
  });
  tufts.receiveShadow = true;
  island.add(tufts);

  const FLOWER = [0xfffbf0, 0xffe066, 0xf6a6c8, 0xc6a8f0, 0xff9a7a];
  const flowerPts = scatter(80, 0.2);
  const stems = new THREE.InstancedMesh(new THREE.BoxGeometry(0.05, 0.22, 0.05).translate(0, 0.11, 0), swayToon(0x4f8f37, 0.35), flowerPts.length);
  const blooms = new THREE.InstancedMesh(new THREE.BoxGeometry(0.15, 0.12, 0.15).translate(0, 0.06, 0), swayToon(0xffffff, 0.35), flowerPts.length);
  flowerPts.forEach(([x, z], i) => {
    stems.setMatrixAt(i, m4.makeTranslation(x, 0, z));
    blooms.setMatrixAt(i, m4.makeTranslation(x, 0.2, z));
    blooms.setColorAt(i, col.set(FLOWER[Math.floor(R() * FLOWER.length)]));
  });
  island.add(stems, blooms);

  // ---------- trees ----------
  const sways = [];
  const trunkMat = toon(0x7a5236);
  for (const t of TREES) {
    const g = new THREE.Group();
    g.position.set(t.x, 0, t.z);
    const s = t.s;
    g.add(box(0.36 * s, 1.4 * s, 0.36 * s, trunkMat, 0, 0.7 * s, 0));
    const crown = new THREE.Group();
    crown.position.y = 1.2 * s;
    if (t.kind === 'round') {
      const a = new THREE.Mesh(new THREE.IcosahedronGeometry(1.2 * s, 0), toon(0x4f9a45)); a.position.y = 0.9 * s;
      const b = new THREE.Mesh(new THREE.IcosahedronGeometry(0.75 * s, 0), toon(0x66b052)); b.position.set(0.35 * s, 1.75 * s, -0.25 * s);
      crown.add(a, b);
    } else {
      [[1.15, 1.5, 0.6], [0.9, 1.3, 1.4], [0.6, 1.1, 2.1]].forEach(([r, h, yy], i) => {
        const c = new THREE.Mesh(flat(new THREE.ConeGeometry(r * s, h * s, 6)), toon(i % 2 ? 0x4a8f55 : 0x3d7d4b));
        c.position.y = yy * s; crown.add(c);
      });
    }
    g.add(crown);
    sways.push({ crown, ph: R() * 6.28 });
    island.add(shadowed(g));
  }

  // ---------- cottage ----------
  const house = new THREE.Group();
  house.position.set(COTTAGE.x, 0, COTTAGE.z);
  const { w, d } = COTTAGE;
  house.add(box(w + 0.25, 0.3, d + 0.25, toon(0x9b958c), 0, 0.15, 0));
  house.add(box(w, 2.4, d, toon(0xf0e4c8), 0, 1.5, 0));
  const roofShape = new THREE.Shape([new THREE.Vector2(-(d + 0.8) / 2, 0), new THREE.Vector2((d + 0.8) / 2, 0), new THREE.Vector2(0, 1.7)]);
  const roofGeo = new THREE.ExtrudeGeometry(roofShape, { depth: w + 0.6, bevelEnabled: false }).translate(0, 0, -(w + 0.6) / 2).rotateY(Math.PI / 2);
  const roof = new THREE.Mesh(roofGeo, toon(0xb4553d));
  roof.position.y = 2.7;
  house.add(roof);
  house.add(box(0.55, 2.0, 0.55, toon(0x9a8f88), 1.1, 3.7, -0.5));
  house.add(box(0.7, 0.12, 0.7, toon(0x7d746e), 1.1, 4.72, -0.5));
  house.add(box(0.75, 1.3, 0.08, toon(0x6b4a2f), -0.7, 0.95, d / 2 + 0.03));
  const glass = toon(0x34405a, { emissive: new THREE.Color(0xffc56e), emissiveIntensity: 0 });
  house.add(box(0.75, 0.62, 0.06, glass, 0.95, 1.75, d / 2 + 0.03));
  house.add(box(0.06, 0.62, 0.62, glass, w / 2 + 0.03, 1.75, 0.75));
  house.add(box(0.06, 0.62, 0.62, glass, w / 2 + 0.03, 1.75, -0.75));
  // flower box under the front window
  house.add(box(0.85, 0.18, 0.22, toon(0x7a5236), 0.95, 1.33, d / 2 + 0.13));
  for (let i = 0; i < 4; i++) house.add(box(0.13, 0.12, 0.13, toon(FLOWER[(i + 1) % FLOWER.length]), 0.67 + i * 0.19, 1.48, d / 2 + 0.13));
  island.add(shadowed(house));
  const porch = new THREE.PointLight(0xffb060, 0, 7, 2);
  porch.position.set(COTTAGE.x + 0.4, 1.3, COTTAGE.z + d / 2 + 1.0);
  island.add(porch);

  // chimney smoke
  const SMOKE_ORIGIN = new THREE.Vector3(COTTAGE.x + 1.1, 4.85, COTTAGE.z - 0.5);
  const LIFE = 10, PUFFS = 10;
  const puffGeo = new THREE.BoxGeometry(1, 1, 1);
  const puffs = Array.from({ length: PUFFS }, (_, i) => {
    const m = new THREE.Mesh(puffGeo, toon(0xece8e2, { transparent: true, depthWrite: false }));
    root.add(m);
    return { m, age: (i * LIFE) / PUFFS, jx: R() - 0.5, jz: R() - 0.5, spin: (R() - 0.5) * 0.4 };
  });

  // ---------- windmill ----------
  const mill = new THREE.Group();
  mill.position.set(MILL.x, 0, MILL.z);
  mill.add(new THREE.Mesh(flat(new THREE.CylinderGeometry(1.35, 1.6, 0.5, 8)), toon(0x9b958c)).translateY(0.25));
  mill.add(new THREE.Mesh(flat(new THREE.CylinderGeometry(0.85, 1.3, 5.6, 8)), toon(0xece4d4)).translateY(3.3));
  mill.add(new THREE.Mesh(flat(new THREE.CylinderGeometry(0.95, 0.95, 0.25, 8)), toon(0x7a5236)).translateY(6.1));
  mill.add(new THREE.Mesh(flat(new THREE.ConeGeometry(1.15, 1.5, 8)), toon(0xa5503c)).translateY(6.95));
  const millDoor = box(0.6, 1.0, 0.1, toon(0x6b4a2f), 0, 1.0, 1.25);
  mill.add(millDoor);
  const hub = new THREE.Group();
  hub.position.set(0, 5.6, 0);
  hub.rotation.y = 25 * Math.PI / 180;
  const rotor = new THREE.Group();
  rotor.position.z = 1.2;
  rotor.add(box(0.3, 0.3, 0.3, toon(0x5a3e2a)));
  for (let i = 0; i < 4; i++) {
    const arm = new THREE.Group();
    arm.rotation.z = i * Math.PI / 2;
    arm.add(box(0.12, 3.6, 0.08, toon(0x7a5a40), 0, 1.85, 0));
    arm.add(box(0.7, 2.7, 0.04, toon(0xf3ecdc), 0.42, 2.15, -0.03));
    rotor.add(arm);
  }
  hub.add(rotor);
  mill.add(hub);
  island.add(shadowed(mill));

  // ---------- fence round the meadow (open on the cliff sides) ----------
  const fenceMat = toon(0x8a6a4a);
  const posts = [], rails = [];
  const F0 = MEADOW.x0 - 0.8;
  for (let v = F0; v <= 9.7; v += 1.0) { posts.push([v, F0]); if (v > F0) posts.push([F0, v]); }
  const gate = z => z > 3.3 && z < 4.6;
  const fence = new THREE.Group();
  for (const [x, z] of posts) if (!(x === F0 && gate(z))) fence.add(box(0.15, 0.8, 0.15, fenceMat, x, 0.4, z));
  for (let v = F0; v < 9.6; v += 1.0) {
    for (const yy of [0.32, 0.62]) {
      fence.add(box(1.0, 0.07, 0.07, fenceMat, v + 0.5, yy, F0));
      if (!gate(v + 0.5)) fence.add(box(0.07, 0.07, 1.0, fenceMat, F0, yy, v + 0.5));
    }
  }
  island.add(shadowed(fence));

  // ---------- sheep ----------
  const wool = toon(0xf4f1ea), face = toon(0x3b3536);
  function makeSheep() {
    const g = new THREE.Group();
    g.add(box(1.05, 0.68, 0.72, wool, 0, 0.74, 0));
    g.add(box(0.75, 0.18, 0.56, wool, -0.05, 1.12, 0));
    const neck = new THREE.Group();
    neck.position.set(0.5, 0.86, 0);
    neck.add(box(0.4, 0.36, 0.36, face, 0.24, 0, 0));
    neck.add(box(0.08, 0.1, 0.16, face, 0.14, 0.12, 0.24));
    neck.add(box(0.08, 0.1, 0.16, face, 0.14, 0.12, -0.24));
    g.add(neck);
    const legs = [[0.32, 0.22], [0.32, -0.22], [-0.32, 0.22], [-0.32, -0.22]].map(([lx, lz]) => {
      const l = new THREE.Group();
      l.position.set(lx, 0.42, lz);
      l.add(box(0.13, 0.42, 0.13, face, 0, -0.21, 0));
      g.add(l);
      return l;
    });
    return { g: shadowed(g), neck, legs };
  }
  const sheep = [[3.5, 6.5, 0.6], [6.8, 3.5, 2.4], [7.2, 7.4, -2.2]].map(([x, z, hd]) => {
    const s = makeSheep();
    s.g.position.set(x, 0, z);
    s.heading = hd;
    s.g.rotation.y = hd;
    island.add(s.g);
    return Object.assign(s, { mode: 'graze', timer: 4 + R2() * 12, headUp: false, look: 2 + R2() * 6, pitch: -0.7, phase: 0, tx: x, tz: z });
  });
  const pickTarget = s => {
    for (let i = 0; i < 12; i++) {
      const a = R2() * Math.PI * 2, r = 1.5 + R2() * 2.5;
      const tx = s.g.position.x + Math.cos(a) * r, tz = s.g.position.z + Math.sin(a) * r;
      // Reject, never clamp: clamping piles every flock into the corners.
      if (!inRect(MEADOW, tx, tz)) continue;
      if (sheep.every(o => o === s || Math.hypot(o.g.position.x - tx, o.g.position.z - tz) > 1.6 && Math.hypot(o.tx - tx, o.tz - tz) > 1.6)) { s.tx = tx; s.tz = tz; return true; }
    }
    return false;
  };
  function updateSheep(s, dt) {
    let want;
    if (s.mode === 'graze') {
      s.look -= dt;
      if (s.look <= 0) { s.headUp = !s.headUp; s.look = s.headUp ? 2 + R2() * 3 : 5 + R2() * 8; }
      want = s.headUp ? 0.08 : -0.72;
      s.timer -= dt;
      if (s.timer <= 0) { if (pickTarget(s)) s.mode = 'walk'; else s.timer = 3; }
    } else {
      want = 0;
      const dx = s.tx - s.g.position.x, dz = s.tz - s.g.position.z;
      const dist = Math.hypot(dx, dz);
      let diff = Math.atan2(-dz, dx) - s.heading;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      s.heading += Math.max(-0.8 * dt, Math.min(0.8 * dt, diff));
      const v = 0.4 * Math.max(0, Math.cos(diff)) ** 2;
      s.g.position.x += Math.cos(s.heading) * v * dt;
      s.g.position.z -= Math.sin(s.heading) * v * dt;
      s.phase += v * dt * 7;
      if (dist < 0.15) { s.mode = 'graze'; s.timer = 10 + R2() * 16; s.headUp = false; s.look = 6 + R2() * 6; }
    }
    s.g.rotation.y = s.heading;
    s.pitch += (want - s.pitch) * (1 - Math.exp(-dt * 1.6));
    s.neck.rotation.z = s.pitch;
    const swing = s.mode === 'walk' ? Math.sin(s.phase) * 0.35 : 0;
    s.legs.forEach((l, i) => { l.rotation.z += ((i === 0 || i === 3 ? swing : -swing) - l.rotation.z) * 0.3; });
  }

  // ---------- clouds ----------
  // Visible clouds drift low, round the island's rock base, so nothing ever
  // covers the cottage. Overhead clouds are shadow-only: invisible, but their
  // shadows still slide across the meadow.
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
    // [start s, altitude, lateral (+ toward camera), speed, visible]
    [-18, -2.2, 8.5, 0.2, true], [6, -1.4, -6, 0.17, true], [20, -4.5, -11, 0.23, true], [-4, -5.5, 4, 0.19, true],
    [-10, 14, 1, 0.3, false], [12, 14, -4, 0.3, false],
  ].map(([s, alt, lat, v, visible]) => {
    const g = makeCloud(visible ? cloudMat : ghostMat, visible ? 1 : 1.4);
    g.traverse(c => { if (c.isMesh) c.castShadow = !visible; });
    root.add(g);
    return { g, s, alt, lat, v };
  });
  const PERP = new THREE.Vector3(0.7071, 0, 0.7071);

  // ---------- fireflies ----------
  const FF = 28;
  const ffPos = new Float32Array(FF * 3), ffCol = new Float32Array(FF * 3);
  const ffMeta = Array.from({ length: FF }, () => {
    const [x, z] = scatter(1, 0)[0] ?? [0, 0];
    return { x, z, y: 0.5 + R() * 1.6, a: R() * 6.28, b: R() * 6.28, c: R() * 6.28, w: 0.9 + R() * 0.6, ph: R() * 6.28 };
  });
  const ffGeo = new THREE.BufferGeometry();
  ffGeo.setAttribute('position', new THREE.BufferAttribute(ffPos, 3));
  ffGeo.setAttribute('color', new THREE.BufferAttribute(ffCol, 3));
  const fireflies = new THREE.Points(ffGeo, new THREE.PointsMaterial({ size: 1, sizeAttenuation: false, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  fireflies.frustumCulled = false;
  root.add(fireflies);

  // ---------- per frame ----------
  function update(dt, t) {
    rotor.rotation.z -= dt * 0.28;
    for (const { crown, ph } of sways) { crown.rotation.z = Math.sin(t * 0.9 + ph) * 0.03; crown.rotation.x = Math.sin(t * 0.7 + ph * 1.3) * 0.02; }

    for (const p of puffs) {
      p.age += dt;
      if (p.age > LIFE) { p.age -= LIFE; p.jx = R2() - 0.5; p.jz = R2() - 0.5; }
      const u = p.age / LIFE;
      p.m.position.copy(SMOKE_ORIGIN).addScaledVector(WIND, u ** 1.5 * 2.2).add(new THREE.Vector3(p.jx * 0.5 * u, u * 4.4, p.jz * 0.5 * u));
      p.m.scale.setScalar(0.28 + u * 0.6);
      p.m.rotation.y = p.spin * p.age;
      p.m.material.opacity = 0.85 * (1 - u) ** 1.3 * Math.min(1, u * 8);
    }

    for (const s of sheep) updateSheep(s, dt);

    const span = Math.max(-world.camera.left, world.camera.right) + 8;
    for (const c of clouds) {
      c.s += dt * c.v;
      if (c.s > span) c.s -= span * 2;
      c.g.position.copy(WIND).multiplyScalar(c.s).addScaledVector(PERP, c.lat).setY(c.alt);
    }

    const lit = world.night;
    glass.emissiveIntensity = lit * 1.8;
    porch.intensity = lit * 9;

    fireflies.material.size = world.pointSize ?? 1;
    const ffA = world.evening;
    fireflies.visible = ffA > 0.01;
    if (fireflies.visible) {
      ffMeta.forEach((f, i) => {
        ffPos[i * 3] = f.x + Math.sin(t * 0.23 + f.a) * 1.2;
        ffPos[i * 3 + 1] = f.y + Math.sin(t * 0.37 + f.b) * 0.35;
        ffPos[i * 3 + 2] = f.z + Math.cos(t * 0.19 + f.c) * 1.2;
        const blink = Math.max(0, Math.sin(t * f.w + f.ph)) ** 2 * ffA;
        ffCol[i * 3] = blink; ffCol[i * 3 + 1] = blink; ffCol[i * 3 + 2] = blink * 0.45;
      });
      ffGeo.attributes.position.needsUpdate = true;
      ffGeo.attributes.color.needsUpdate = true;
    }
  }

  return {
    root,
    update,
    frame: island,
  };
}
