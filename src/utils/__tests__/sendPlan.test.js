import { describe, it, expect } from 'vitest';
import { clampDelay, MAX_DELAY_MINUTES, FREE_DELAY_MINUTES } from '../sendPlan';

describe('clampDelay', () => {
  it('adds hours and minutes', () => {
    expect(clampDelay(2, 30)).toBe(150);
  });

  it('never goes past 24 hours and 0 minutes', () => {
    expect(clampDelay(24, 0)).toBe(MAX_DELAY_MINUTES);
    expect(clampDelay(24, 15)).toBe(MAX_DELAY_MINUTES);
    expect(clampDelay(99, 59)).toBe(MAX_DELAY_MINUTES);
  });

  it('never goes below zero, and reads junk as zero', () => {
    expect(clampDelay(0, -5)).toBe(0);
    expect(clampDelay('', 'x')).toBe(0);
  });

  it('holds a free user to the undo window', () => {
    expect(clampDelay(1, 0, FREE_DELAY_MINUTES)).toBe(5);
  });
});
