// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { nextInk, INK_TO_LIGHT, INK_TO_DARK } from '../ink.js';

describe('nextInk', () => {
  it('starts dark on a bright sky and light on a dark one', () => {
    expect(nextInk(null, 0.4)).toBe('dark');
    expect(nextInk(null, 0.05)).toBe('light');
  });

  it('holds whichever ink it has while the sky is inside the gap', () => {
    const mid = (INK_TO_LIGHT + INK_TO_DARK) / 2;
    expect(nextInk('dark', mid)).toBe('dark');
    expect(nextInk('light', mid)).toBe('light');
  });

  it('switches only once the sky is clearly past the other threshold', () => {
    expect(nextInk('dark', INK_TO_LIGHT - 0.001)).toBe('light');
    expect(nextInk('light', INK_TO_DARK + 0.001)).toBe('dark');
  });
});
