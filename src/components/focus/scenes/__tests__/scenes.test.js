// @vitest-environment node
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { makeKit } from '../world.js';
import { SCENE_LOADERS } from '../index.js';

// Everything a scene reads from the world, minus the renderer: no WebGL here.
function fakeWorld() {
  return {
    ...makeKit(),
    scene: new THREE.Scene(),
    camera: new THREE.OrthographicCamera(-30, 30, 20, -20, 1, 400),
    night: 1, evening: 0, sunElev: 8, pointSize: 2, progress: 0,
  };
}

const finite = arr => Array.prototype.every.call(arr, Number.isFinite);

describe.each(Object.keys(SCENE_LOADERS))('the %s scene', (name) => {
  it('builds, and runs ten minutes from dawn to night without a NaN anywhere', async () => {
    const { createScene } = await SCENE_LOADERS[name]();
    const world = fakeWorld();
    const s = createScene(world);
    expect(s.root.isObject3D).toBe(true);
    expect(s.frame?.isObject3D).toBe(true);

    const FRAMES = 18_000, dt = 1 / 30;
    for (let i = 0, t = 0; i < FRAMES; i++) {
      const p = i / FRAMES;
      world.progress = p;
      world.night = p < 0.05 || p > 0.93 ? 1 : 0;
      world.evening = Math.max(0, Math.min(1, (p - 0.84) / 0.12));
      t += dt;
      world.uTime.value = t;
      s.update(dt, t, world);
    }

    s.root.updateMatrixWorld(true);
    const bad = [];
    s.root.traverse(o => {
      if (!finite(o.matrixWorld.elements)) bad.push(`${o.type} matrix`);
      if (o.isInstancedMesh && !finite(o.instanceMatrix.array)) bad.push(`${o.type} instances`);
      if (o.isPoints && !finite(o.geometry.attributes.position.array)) bad.push('points');
    });
    expect(bad).toEqual([]);
  });

  it('keeps everything the shot is framed on inside the island', async () => {
    const { createScene } = await SCENE_LOADERS[name]();
    const s = createScene(fakeWorld());
    const box = new THREE.Box3().setFromObject(s.frame);
    // 20x20 island; a dock or a sail may lean a little past the edge, nothing more.
    expect(box.min.x).toBeGreaterThan(-12);
    expect(box.max.x).toBeLessThan(12);
    expect(box.min.z).toBeGreaterThan(-12);
    expect(box.max.z).toBeLessThan(12);
  });
});
