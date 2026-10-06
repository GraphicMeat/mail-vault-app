// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

// jsdom has no WebGL. A stand-in renderer lets the real engine run around it.
const gpu = vi.hoisted(() => ({ renders: 0, disposed: 0, lost: 0 }));
vi.mock('three', async (importOriginal) => {
  const THREE = await importOriginal();
  class WebGLRenderer {
    constructor() { this.shadowMap = {}; }
    setPixelRatio() {}
    setSize() {}
    render() { gpu.renders += 1; }
    dispose() { gpu.disposed += 1; }
    forceContextLoss() { gpu.lost += 1; }
  }
  return { ...THREE, WebGLRenderer };
});

const THREE = await import('three');
const { createWorld, skyLuminanceAt } = await import('../world.js');

function host() {
  const div = document.createElement('div');
  const canvas = document.createElement('canvas');
  div.appendChild(canvas);
  document.body.appendChild(div);
  return canvas;
}

/** A one-box scene whose update does what the case asks. */
const sceneThat = (update) => () => {
  const root = new THREE.Group();
  root.add(new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2)));
  return { root, frame: root, update };
};

beforeEach(() => {
  Object.assign(gpu, { renders: 0, disposed: 0, lost: 0 });
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  document.body.innerHTML = '';
});

describe('createWorld', () => {
  it('stops a scene that throws after the first error, and reports it once', () => {
    const world = createWorld(host(), { still: true });
    const onError = vi.fn();
    world.onError = onError;
    let updates = 0;
    world.mount(sceneThat(() => { updates += 1; throw new Error('scene update threw'); }));

    world.setProgress(0.5);
    world.setProgress(0.9);
    world.start();

    expect(updates).toBe(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0].message).toBe('scene update threw');
    expect(gpu.renders).toBe(0);
    world.dispose();
  });

  it('keeps drawing a healthy still scene as the session moves on', () => {
    const world = createWorld(host(), { still: true });
    world.onError = vi.fn();
    let updates = 0;
    world.mount(sceneThat(() => { updates += 1; }));
    const before = gpu.renders;
    world.setProgress(0.5);
    world.setProgress(0.9);
    expect(gpu.renders).toBe(before + 2);
    expect(updates).toBeGreaterThanOrEqual(2);
    expect(world.onError).not.toHaveBeenCalled();
    world.dispose();
  });

  it('hands the GPU context back when disposed', () => {
    const world = createWorld(host(), { still: true });
    world.mount(sceneThat(() => {}));
    world.dispose();
    expect(gpu.disposed).toBe(1);
    expect(gpu.lost).toBe(1);
  });
});

describe('skyLuminanceAt', () => {
  // FocusScene inks the countdown dark above 0.24 and light below 0.2.
  it('keeps the sky bright from dawn through golden hour, and dark at the end', () => {
    for (const p of [0, 0.1, 0.35, 0.62, 0.8]) expect(skyLuminanceAt(p), `p ${p}`).toBeGreaterThan(0.24);
    for (const p of [0.92, 0.96, 1]) expect(skyLuminanceAt(p), `p ${p}`).toBeLessThan(0.2);
  });

  it('crosses from bright to dark once in a session, never back', () => {
    let crossings = 0, prevDark = false;
    for (let i = 0; i <= 200; i++) {
      const dark = skyLuminanceAt(i / 200) < 0.22;
      if (dark !== prevDark) crossings += 1;
      prevDark = dark;
    }
    expect(crossings).toBe(1);
  });
});
