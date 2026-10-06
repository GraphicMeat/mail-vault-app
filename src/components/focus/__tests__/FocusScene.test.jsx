// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { createRef } from 'react';
import { render, cleanup, waitFor, act } from '@testing-library/react';

// A stand-in engine: jsdom has no WebGL. It records what FocusScene asks of it.
const fake = vi.hoisted(() => ({ worlds: [], throwOnCreate: false, lum: 0.4 }));
vi.mock('../scenes/index.js', () => {
  const scene = () => Promise.resolve({ createScene: () => ({}) });
  return {
    SCENE_LOADERS: { countryside: scene, sea: scene, town: scene },
    loadWorld: () => Promise.resolve({
      createWorld: (canvas, opts) => {
        if (fake.throwOnCreate) throw new Error('Error creating WebGL context.');
        const w = {
          canvas, opts, progress: [], inset: [], started: 0, disposed: 0, mounted: null, onFrame: null, onError: null,
          mount(fn) { this.mounted = fn; },
          setProgress(p) { this.progress.push(p); },
          setInsetTop(px) { this.inset.push(px); },
          start() { this.started += 1; },
          dispose() { this.disposed += 1; },
          skyLuminance() { return fake.lum; },
        };
        fake.worlds.push(w);
        return w;
      },
    }),
  };
});

const { FocusScene } = await import('../FocusScene');

const NOW = 1_700_000_000_000;
const world = () => fake.worlds[fake.worlds.length - 1];

beforeEach(() => {
  fake.worlds = [];
  fake.throwOnCreate = false;
  fake.lum = 0.4;
  // Only the clock: waitFor polls with real timers.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  window.matchMedia = undefined;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const session = { startedAt: NOW - 10 * 60_000, endsAt: NOW + 10 * 60_000 };

describe('FocusScene', () => {
  it('loads the scene and puts its day where the session is: halfway through, half the day', async () => {
    const { container } = render(<FocusScene scene="sea" {...session} />);
    await waitFor(() => expect(world()?.started).toBe(1));
    expect(world().mounted).toBeTypeOf('function');
    expect(world().progress[0]).toBeCloseTo(0.5, 5);
    expect(world().opts.still).toBe(false);
    expect(typeof world().onFrame).toBe('function');
    expect(container.querySelector('canvas').className).toBe('is-ready');
    expect(container.firstChild.getAttribute('data-scene')).toBe('sea');
  });

  it('moves the day on as the session runs', async () => {
    render(<FocusScene scene="countryside" {...session} />);
    await waitFor(() => expect(world()?.started).toBe(1));
    vi.setSystemTime(NOW + 10 * 60_000);
    world().onFrame(1 / 30);
    expect(world().progress.at(-1)).toBe(1);
  });

  it('holds still under reduced motion, while its light still follows the session', async () => {
    window.matchMedia = (q) => ({ matches: q.includes('reduce'), addEventListener() {}, removeEventListener() {} });
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(NOW);
    render(<FocusScene scene="town" {...session} />);
    await waitFor(() => expect(world()?.started).toBe(1));
    expect(world().opts.still).toBe(true);
    expect(world().onFrame).toBe(null);
    const before = world().progress.length;
    act(() => { vi.advanceTimersByTime(5_000); });
    expect(world().progress.length).toBe(before + 1);
    // 10 minutes in plus the 5 seconds just passed, of a 20-minute session.
    expect(world().progress.at(-1)).toBeCloseTo((600_000 + 5_000) / 1_200_000, 9);
  });

  it('frames the scene in the space below the countdown', async () => {
    const textRef = createRef();
    const text = document.createElement('div');
    // Layout offsets: a rect would be skewed by the lock's opening scale animation.
    Object.defineProperty(text, 'offsetTop', { value: 40 });
    Object.defineProperty(text, 'offsetHeight', { value: 190 });
    text.getBoundingClientRect = () => ({ top: 38, bottom: 218, left: 0, right: 0, width: 0, height: 180 });
    textRef.current = text;
    render(<FocusScene scene="sea" {...session} textRef={textRef} />);
    await waitFor(() => expect(world()?.started).toBe(1));
    expect(world().inset.at(-1)).toBe(40 + 190 + 12);
  });

  it('does not redraw a still scene while the window is hidden', async () => {
    window.matchMedia = (q) => ({ matches: q.includes('reduce'), addEventListener() {}, removeEventListener() {} });
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(NOW);
    render(<FocusScene scene="town" {...session} />);
    await waitFor(() => expect(world()?.started).toBe(1));
    const before = world().progress.length;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    try {
      act(() => { vi.advanceTimersByTime(15_000); });
      expect(world().progress.length).toBe(before);
    } finally {
      delete document.hidden;
    }
  });

  it('falls back to the plain lock when the scene breaks mid-session, and says so once', async () => {
    const onUnavailable = vi.fn();
    render(<FocusScene scene="sea" {...session} onUnavailable={onUnavailable} />);
    await waitFor(() => expect(world()?.started).toBe(1));
    expect(typeof world().onError).toBe('function');
    act(() => world().onError(new Error('scene update threw')));
    expect(onUnavailable).toHaveBeenCalledTimes(1);
  });

  it('draws each session on a fresh canvas, never on one whose GPU context was handed back', async () => {
    const { container, rerender } = render(<FocusScene scene="sea" {...session} />);
    await waitFor(() => expect(world()?.started).toBe(1));
    const first = container.querySelector('canvas');
    rerender(<FocusScene scene="sea" startedAt={session.startedAt + 1} endsAt={session.endsAt + 1} />);
    await waitFor(() => expect(fake.worlds.length).toBe(2));
    expect(fake.worlds[0].disposed).toBe(1);
    expect(container.querySelector('canvas')).not.toBe(first);
    expect(fake.worlds[1].canvas).toBe(container.querySelector('canvas'));
  });

  it('says so when this machine cannot draw it, so the lock goes plain', async () => {
    fake.throwOnCreate = true;
    const onUnavailable = vi.fn();
    render(<FocusScene scene="sea" {...session} onUnavailable={onUnavailable} />);
    await waitFor(() => expect(onUnavailable).toHaveBeenCalledTimes(1));
  });

  it('says so when the GPU drops the scene mid-session', async () => {
    const onUnavailable = vi.fn();
    render(<FocusScene scene="sea" {...session} onUnavailable={onUnavailable} />);
    await waitFor(() => expect(world()?.started).toBe(1));
    act(() => { world().canvas.dispatchEvent(new Event('webglcontextlost')); });
    expect(onUnavailable).toHaveBeenCalledTimes(1);
  });

  it('says so for a scene it has no loader for', async () => {
    const onUnavailable = vi.fn();
    render(<FocusScene scene="volcano" {...session} onUnavailable={onUnavailable} />);
    await waitFor(() => expect(onUnavailable).toHaveBeenCalledTimes(1));
    expect(fake.worlds).toEqual([]);
  });

  it('gives the GPU back when the lock closes, and blames nobody for it', async () => {
    const onUnavailable = vi.fn();
    const { unmount } = render(<FocusScene scene="countryside" {...session} onUnavailable={onUnavailable} />);
    await waitFor(() => expect(world()?.started).toBe(1));
    const w = world();
    unmount();
    expect(w.disposed).toBe(1);
    w.canvas.dispatchEvent(new Event('webglcontextlost'));
    expect(onUnavailable).not.toHaveBeenCalled();
  });

  it('inks the countdown dark on a bright sky, light on a dark one, without flickering at the crossover', async () => {
    const textRef = createRef();
    textRef.current = document.createElement('div');
    render(<FocusScene scene="countryside" {...session} textRef={textRef} />);
    await waitFor(() => expect(world()?.started).toBe(1));
    const ink = () => textRef.current.dataset.ink;
    expect(ink()).toBe('dark');

    fake.lum = 0.21;                 // inside the gap: stays as it is
    world().onFrame(1 / 30);
    expect(ink()).toBe('dark');
    fake.lum = 0.15;                 // dusk
    world().onFrame(1 / 30);
    expect(ink()).toBe('light');
    fake.lum = 0.22;                 // back inside the gap: still light
    world().onFrame(1 / 30);
    expect(ink()).toBe('light');
    fake.lum = 0.3;
    world().onFrame(1 / 30);
    expect(ink()).toBe('dark');
  });
});
