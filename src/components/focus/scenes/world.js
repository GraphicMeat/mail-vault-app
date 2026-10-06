/**
 * The pixel-art 3D world every focus scene runs in.
 *
 * - Orthographic iso camera, fixed: a moving camera makes every art pixel
 *   crawl, the opposite of calm.
 * - Rendered at a fraction of the window and upscaled nearest-neighbour, with
 *   a three-step toon ramp, so real 3D reads as pixel art (sizing: view.js).
 * - The light follows the session: dawn at the start, night at the end.
 * - A dithered gradient sky with sun, moon and stars behind the diorama.
 *
 * Loaded on demand with the lock, so three.js never weighs on startup.
 */
import * as THREE from 'three';
import { computeView } from './view.js';

const DEG = Math.PI / 180;
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = t => t * t * (3 - 2 * t);
const clamp01 = x => Math.min(1, Math.max(0, x));

// Sky and light along the session: dawn, day, golden hour, dusk, night.
const STOPS = [
  { p: 0.00, top: 0x8f9fd6, bot: 0xffc59a, sun: 0xffbf8a, sunI: 1.3, hemiI: 0.85, ground: 0x8a7058 },
  { p: 0.14, top: 0x5fb2ee, bot: 0xc4e9ff, sun: 0xfff3dc, sunI: 1.9, hemiI: 1.0, ground: 0x7d7556 },
  { p: 0.62, top: 0x5fb2ee, bot: 0xc4e9ff, sun: 0xfff0d8, sunI: 1.9, hemiI: 1.0, ground: 0x7d7556 },
  { p: 0.80, top: 0x86a6d6, bot: 0xffb072, sun: 0xffb36b, sunI: 1.65, hemiI: 0.72, ground: 0x8a6448 },
  { p: 0.91, top: 0x434785, bot: 0xe5897c, sun: 0xd48aa8, sunI: 0.75, hemiI: 0.55, ground: 0x4a4060 },
  { p: 1.00, top: 0x121735, bot: 0x343a72, sun: 0x9fb0ff, sunI: 0.5, hemiI: 0.45, ground: 0x2a2a46 },
].map(s => ({ ...s, top: new THREE.Color(s.top), bot: new THREE.Color(s.bot), sun: new THREE.Color(s.sun), ground: new THREE.Color(s.ground) }));

const WHITE = new THREE.Color(0xffffff);
const _top = new THREE.Color(), _sky = new THREE.Color();

/**
 * Relative luminance of the sky behind the countdown at session progress p.
 * The countdown sits in the top fifth, where the gradient is mostly the top
 * colour. The lock picks dark or light text from this, so the text keeps its
 * contrast from dawn to night.
 */
export function skyLuminanceAt(p) {
  p = clamp01(p);
  let i = 0;
  while (i < STOPS.length - 2 && p > STOPS[i + 1].p) i++;
  const a = STOPS[i], b = STOPS[i + 1];
  const k = smooth(clamp01((p - a.p) / (b.p - a.p)));
  _top.copy(a.top).lerp(b.top, k);
  _sky.copy(a.bot).lerp(b.bot, k).lerp(_top, 0.85);
  // THREE.Color holds linear values, which is what luminance is defined on.
  return 0.2126 * _sky.r + 0.7152 * _sky.g + 0.0722 * _sky.b;
}

const SKY_VS = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.999, 1.0); }`;

const SKY_FS = /* glsl */`
  uniform vec3 uTop, uBot, uSun, uMoon;
  uniform vec2 uRes, uSunPos, uMoonPos;
  uniform float uSunA, uMoonA, uSunR;
  varying vec2 vUv;
  float bayer2(vec2 a) { a = floor(a); return fract(dot(a, vec2(0.5, a.y * 0.75))); }
  float bayer4(vec2 a) { return bayer2(0.5 * a) * 0.25 + bayer2(a); }
  void main() {
    vec2 px = floor(gl_FragCoord.xy);
    vec3 col = mix(uBot, uTop, smoothstep(0.0, 1.0, vUv.y));
    float d = length(px - floor(uSunPos * uRes));
    col = mix(col, uSun, uSunA * 0.6 * exp(-d / (uSunR * 4.0)));
    vec4 o = linearToOutputTexel(vec4(col, 1.0));
    // Ordered dither onto a coarse palette: the banding IS the pixel look.
    o.rgb = floor(o.rgb * 22.0 + bayer4(px)) / 22.0;
    if (d <= uSunR) o.rgb = mix(o.rgb, linearToOutputTexel(vec4(uSun, 1.0)).rgb, uSunA);
    vec2 m = px - floor(uMoonPos * uRes);
    float moon = step(length(m), uSunR * 0.85) * step(uSunR * 0.75, length(m - vec2(uSunR * 0.45, uSunR * 0.25)));
    o.rgb = mix(o.rgb, linearToOutputTexel(vec4(uMoon, 1.0)).rgb, moon * uMoonA);
    gl_FragColor = o;
  }`;

/** Seeded PRNG, so a scene lays out the same way every time. */
export function rng(seed) {
  return () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The materials and helpers a scene builds with. Needs no renderer, so the
 * scene tests can build every scene in Node.
 */
export function makeKit() {
  const ramp = new THREE.DataTexture(new Uint8Array([80, 160, 255]), 3, 1, THREE.RedFormat);
  ramp.minFilter = ramp.magFilter = THREE.NearestFilter;
  ramp.needsUpdate = true;
  const toon = (color, extra = {}) => new THREE.MeshToonMaterial({ color, gradientMap: ramp, ...extra });
  // Toon has no flatShading switch: split vertices so every face keeps its own normal.
  const flat = geo => { const g = geo.index ? geo.toNonIndexed() : geo; g.computeVertexNormals(); return g; };
  const uTime = { value: 0 };
  /** Toon material whose instances lean downwind in travelling gusts; the lean grows with height above `base`. */
  const swayToon = (color, amp, base = 0) => {
    const m = toon(color);
    const uAmp = { value: amp }, uBase = { value: base };
    m.onBeforeCompile = sh => {
      sh.uniforms.uTime = uTime;
      sh.uniforms.uAmp = uAmp;
      sh.uniforms.uBase = uBase;
      sh.vertexShader = 'uniform float uTime;\nuniform float uAmp;\nuniform float uBase;\n' + sh.vertexShader.replace('#include <begin_vertex>', `
        #include <begin_vertex>
        #ifdef USE_INSTANCING
          vec4 wp = instanceMatrix * vec4(position, 1.0);
          float along = (wp.x - wp.z) * 0.7071;
          float gust = 0.55 + 0.3 * sin(uTime * 1.15 - along * 0.32) + 0.15 * sin(uTime * 0.53 + wp.x * 0.7 + wp.z * 0.4);
          float lean = gust * uAmp * max(wp.y - uBase, 0.0);
          transformed.x += lean * 0.7071;
          transformed.z -= lean * 0.7071;
        #endif`);
    };
    return m;
  };
  return { THREE, ramp, toon, flat, swayToon, uTime, rng, lerp, smooth, clamp01 };
}

/**
 * @param {HTMLCanvasElement} canvas  sized to its parent element
 * @param {object} [opts]
 * @param {number} [opts.detail=32]  art pixels per world unit
 * @param {number} [opts.fill=0.86]  share of the free area the diorama spans
 * @param {boolean} [opts.still]     reduced motion: no animation loop, the
 *                                   light still follows the session
 * Throws when WebGL is unavailable; the caller falls back to the plain lock.
 */
export function createWorld(canvas, { detail = 32, fill = 0.86, still = false } = {}) {
  const kit = makeKit();
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'low-power' });
  renderer.setPixelRatio(1);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.BasicShadowMap;

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 400);
  scene.add(camera);
  const azimuth = 45 * DEG, elevation = 32 * DEG;
  camera.position.set(Math.cos(elevation) * Math.sin(azimuth), Math.sin(elevation), Math.cos(elevation) * Math.cos(azimuth)).multiplyScalar(120);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  let bounds = { x0: -15, x1: 15, y0: -12, y1: 12 };
  let insetTop = 0;

  const sun = new THREE.DirectionalLight(0xffffff, 1.8);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, { left: -32, right: 32, top: 32, bottom: -32, near: 1, far: 160 });
  sun.shadow.bias = -0.0015;
  scene.add(sun, sun.target);
  const hemi = new THREE.HemisphereLight(0xffffff, 0x888866, 0.9);
  scene.add(hemi);

  const skyU = {
    uTop: { value: new THREE.Color() }, uBot: { value: new THREE.Color() },
    uSun: { value: new THREE.Color() }, uMoon: { value: new THREE.Color(0xf4f0d6) },
    uRes: { value: new THREE.Vector2(1, 1) }, uSunPos: { value: new THREE.Vector2() }, uMoonPos: { value: new THREE.Vector2(0.16, 0.8) },
    uSunA: { value: 1 }, uMoonA: { value: 0 }, uSunR: { value: 5 },
  };
  const sky = new THREE.Mesh(new THREE.PlaneGeometry(2, 2),
    new THREE.ShaderMaterial({ uniforms: skyU, vertexShader: SKY_VS, fragmentShader: SKY_FS, depthTest: false, depthWrite: false }));
  sky.frustumCulled = false;
  sky.renderOrder = -1000;
  scene.add(sky);

  // Stars ride on the camera at screen fractions and refill the frustum on resize.
  const R = rng(99);
  const STAR_N = 90;
  const starPos = new Float32Array(STAR_N * 3), starCol = new Float32Array(STAR_N * 3);
  const starMeta = Array.from({ length: STAR_N }, () => ({ u: R(), v: 0.25 + R() * 0.75, w: 0.6 + R() * 0.6, ph: R() * 6.28, b: 0.4 + R() * 0.6 }));
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
  starGeo.setAttribute('color', new THREE.BufferAttribute(starCol, 3));
  const stars = new THREE.Points(starGeo, new THREE.PointsMaterial({
    size: 1, sizeAttenuation: false, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  stars.frustumCulled = false;
  camera.add(stars);

  let progress = -1;
  let current = null;
  const world = {
    ...kit, scene, camera, sun, hemi,
    get progress() { return Math.max(0, progress); },
    night: 0, evening: 0, sunElev: 0, pointSize: 1,
    onFrame: null,
    onError: null,
  };

  /** Extent of `frame` on the camera plane, in world units. */
  function measure(frame) {
    frame.updateMatrixWorld(true);
    const inv = camera.matrixWorldInverse, box = new THREE.Box3(), v = new THREE.Vector3();
    const b = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity };
    frame.traverse(o => {
      if (!o.isMesh || !o.visible) return;
      box.makeEmpty().expandByObject(o);
      for (let i = 0; i < 8; i++) {
        v.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).applyMatrix4(inv);
        b.x0 = Math.min(b.x0, v.x); b.x1 = Math.max(b.x1, v.x);
        b.y0 = Math.min(b.y0, v.y); b.y1 = Math.max(b.y1, v.y);
      }
    });
    return b;
  }

  function setProgress(p, force = false) {
    p = clamp01(p);
    // The day moves a hair per frame; repainting the palette for less than
    // that is wasted work.
    if (!force && Math.abs(p - progress) < 2e-4) return false;
    progress = p;
    let i = 0;
    while (i < STOPS.length - 2 && p > STOPS[i + 1].p) i++;
    const a = STOPS[i], b = STOPS[i + 1];
    const k = smooth(clamp01((p - a.p) / (b.p - a.p)));
    skyU.uTop.value.copy(a.top).lerp(b.top, k);
    skyU.uBot.value.copy(a.bot).lerp(b.bot, k);
    sun.color.copy(a.sun).lerp(b.sun, k);
    sun.intensity = lerp(a.sunI, b.sunI, k);
    hemi.color.copy(skyU.uTop.value).lerp(skyU.uBot.value, 0.5).lerp(WHITE, 0.35);
    hemi.groundColor.copy(a.ground).lerp(b.ground, k);
    hemi.intensity = lerp(a.hemiI, b.hemiI, k);
    // The light arcs left to right across the session, low at both ends so shadows stretch.
    const elev = (8 + 62 * Math.sin(p * Math.PI)) * DEG;
    const az = lerp(-65, 65, p) * DEG + azimuth;
    sun.position.set(Math.cos(elev) * Math.sin(az), Math.sin(elev), Math.cos(elev) * Math.cos(az)).multiplyScalar(70);
    world.sunElev = elev / DEG;
    world.night = 1 - smooth(clamp01((world.sunElev - 10) / 14));
    world.evening = smooth(clamp01((p - 0.84) / 0.12));
    // The sun disc keeps to the side margins, rising out of the bottom-left
    // corner and setting into the bottom-right, so it never crosses the countdown.
    const sx = p < 0.5 ? lerp(0.07, 0.2, p * 2) : lerp(0.8, 0.93, (p - 0.5) * 2);
    skyU.uSunPos.value.set(sx, 1.4 * Math.sin(p * Math.PI) - 0.02);
    skyU.uSun.value.copy(sun.color).lerp(WHITE, 0.35);
    skyU.uSunA.value = 1 - smooth(clamp01((p - 0.92) / 0.05));
    skyU.uMoonA.value = world.evening;
    return true;
  }

  // A scene that throws once would throw every frame, 30 times a second, for
  // the whole session. The first error stops the scene for good and tells the
  // caller, which falls back to the plain lock.
  let broken = false;
  const fail = (err) => {
    if (broken) return;
    broken = true;
    world.stop();
    world.onError?.(err);
  };

  function resize() {
    if (broken) return;
    try { layout(); } catch (err) { fail(err); }
  }

  function layout() {
    const host = canvas.parentElement;
    if (!host) return;
    // Layout size, not getBoundingClientRect: the lock opens with a scale
    // animation, and a transformed rect would size the canvas to 95% for the
    // whole session (ResizeObserver never reports a transform ending).
    const v = computeView({ w: host.clientWidth, h: host.clientHeight, dpr: window.devicePixelRatio || 1, insetTop, bounds, detail, fill });
    renderer.setSize(v.rw, v.rh, false);
    canvas.style.width = `${v.cssW}px`;
    canvas.style.height = `${v.cssH}px`;
    Object.assign(camera, v.frustum);
    camera.updateProjectionMatrix();
    starMeta.forEach((m, i) => {
      starPos[i * 3] = lerp(camera.left, camera.right, m.u);
      starPos[i * 3 + 1] = lerp(camera.bottom, camera.top, m.v);
      starPos[i * 3 + 2] = -300;
    });
    starGeo.attributes.position.needsUpdate = true;
    // Points are sized in art pixels: grow them with detail so a star stays visible.
    world.pointSize = Math.max(1, Math.round(detail / 10));
    stars.material.size = world.pointSize;
    skyU.uRes.value.set(v.rw, v.rh);
    skyU.uSunR.value = Math.max(3, Math.round(Math.min(v.rw, v.rh) / 34));
    // setSize cleared the canvas. Repaint now rather than on the next
    // animation frame: a lock that opens in a hidden or covered window gets
    // none, and the fade-in must never reveal an empty or stale canvas.
    draw(0);
  }

  let t = 0;
  function draw(dt) {
    if (broken) return;
    try {
      t += dt;
      kit.uTime.value = t;
      starMeta.forEach((m, i) => {
        const s = world.evening * m.b * (0.55 + 0.45 * Math.sin(t * m.w + m.ph));
        starCol[i * 3] = s; starCol[i * 3 + 1] = s; starCol[i * 3 + 2] = s * 0.95;
      });
      starGeo.attributes.color.needsUpdate = true;
      current?.update(dt, t, world);
      renderer.render(scene, camera);
    } catch (err) {
      fail(err);
    }
  }

  // 30 fps is plenty for motion this slow, and half the battery of 60.
  let raf = 0, last = 0, acc = 0;
  const STEP = 1 / 30;
  function frame(now) {
    raf = requestAnimationFrame(frame);
    acc += Math.min(0.1, (now - last) / 1000);
    last = now;
    if (acc < STEP) return;
    const dt = acc;
    acc = 0;
    try { world.onFrame?.(dt); } catch (err) { fail(err); }
    draw(dt);
  }

  const onVisibility = () => (document.hidden ? world.stop() : world.start());
  const ro = new ResizeObserver(resize);
  // Dragging the window to a display with another scale factor changes the
  // device pixel ratio without a resize.
  let mq = null;
  const onDpr = () => { resize(); watchDpr(); };
  const watchDpr = () => {
    mq?.removeEventListener?.('change', onDpr);
    mq = window.matchMedia?.(`(resolution: ${window.devicePixelRatio || 1}dppx)`) ?? null;
    mq?.addEventListener?.('change', onDpr);
  };

  world.mount = createScene => {
    current = createScene(world);
    scene.add(current.root);
    bounds = measure(current.frame ?? current.root);
    setProgress(world.progress, true);
    resize();
  };
  // With the loop running the next frame shows it; otherwise paint it now.
  world.setProgress = p => { if (setProgress(p) && (still || !raf)) draw(0); };
  world.skyLuminance = () => skyLuminanceAt(world.progress);
  world.setInsetTop = px => { if (Math.abs(px - insetTop) > 0.5) { insetTop = px; resize(); } };
  world.start = () => {
    if (broken) return;
    if (still) { draw(0); return; }
    if (!raf && !document.hidden) { last = performance.now(); raf = requestAnimationFrame(frame); }
  };
  world.stop = () => { cancelAnimationFrame(raf); raf = 0; };
  world.dispose = () => {
    world.stop();
    document.removeEventListener('visibilitychange', onVisibility);
    ro.disconnect();
    mq?.removeEventListener?.('change', onDpr);
    scene.traverse(o => {
      o.geometry?.dispose();
      const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
      mats.forEach(m => m.dispose());
    });
    kit.ramp.dispose();
    renderer.dispose();
    // Hand the context back now: WebKit caps live WebGL contexts, and a lock
    // opened many times a day must not leak one each time.
    renderer.forceContextLoss();
  };

  document.addEventListener('visibilitychange', onVisibility);
  if (canvas.parentElement) ro.observe(canvas.parentElement);
  watchDpr();
  return world;
}
