import { describe, it, expect } from 'vitest';
import { clampComposeSize, MIN_COMPOSE_WIDTH, MIN_COMPOSE_HEIGHT } from '../composeSize';

describe('clampComposeSize', () => {
  it('floors a size below the minimum to 200x200', () => {
    expect(clampComposeSize({ width: 50, height: 80 })).toEqual({ width: 200, height: 200 });
    expect(clampComposeSize({ width: 199, height: 500 })).toEqual({ width: 200, height: 500 });
  });

  it('passes through a size already within bounds, rounded', () => {
    expect(clampComposeSize({ width: 640.4, height: 520.6 })).toEqual({ width: 640, height: 521 });
  });

  it('never returns below the floor even against a tiny viewport', () => {
    // A viewport smaller than the floor (e.g. a very small monitor) must not
    // shrink the result past the minimum every compose surface enforces.
    expect(clampComposeSize({ width: 900, height: 800 }, { width: 100, height: 120 }))
      .toEqual({ width: MIN_COMPOSE_WIDTH, height: MIN_COMPOSE_HEIGHT });
  });

  it('clamps a size saved on a bigger monitor down to the current viewport', () => {
    expect(clampComposeSize({ width: 1800, height: 1200 }, { width: 1000, height: 700 }))
      .toEqual({ width: 1000, height: 700 });
  });

  it('returns null for a missing or malformed size', () => {
    expect(clampComposeSize(null)).toBeNull();
    expect(clampComposeSize(undefined)).toBeNull();
    expect(clampComposeSize({ width: 'nope', height: 400 })).toBeNull();
  });
});
