import { describe, it, expect } from 'vitest';
import { planPages, MAX_PAGE_AREA } from '../imagePacker';

const size = (h) => ({ width: 1640, height: h });

describe('planPages', () => {
  it('puts one small message on one page', () => {
    const plan = planPages([size(2000)]);
    expect(plan).toHaveLength(1);
    expect(plan[0].items).toEqual([0]);
  });

  it('keeps messages together while they fit', () => {
    const plan = planPages([size(2000), size(2000), size(2000)]);
    expect(plan).toHaveLength(1);
    expect(plan[0].items).toEqual([0, 1, 2]);
  });

  it('breaks at a message boundary rather than mid-message', () => {
    const tall = Math.floor(MAX_PAGE_AREA / 1640) - 100;
    const plan = planPages([size(tall), size(tall)]);
    expect(plan).toHaveLength(2);
    expect(plan[0].items).toEqual([0]);
    expect(plan[1].items).toEqual([1]);
  });

  it('hard-slices a single message that cannot fit on any page', () => {
    const overlong = Math.floor(MAX_PAGE_AREA / 1640) * 2 + 500;
    const plan = planPages([size(overlong)]);
    expect(plan.length).toBeGreaterThan(1);
    expect(plan.every(p => Array.isArray(p.items))).toBe(true);
    expect(plan[0].slice).toBeDefined();
    expect(plan[0].slice.index).toBe(0);
    expect(plan[0].slice.offsetY).toBe(0);
    expect(plan[1].slice.offsetY).toBeGreaterThan(0);
  });

  it('never exceeds the area cap on any page', () => {
    const plan = planPages([size(3000), size(4000), size(5000), size(6000)]);
    for (const page of plan) {
      const height = page.slice
        ? page.slice.height
        : page.items.reduce((sum, i) => sum + [3000, 4000, 5000, 6000][i], 0);
      expect(1640 * height).toBeLessThanOrEqual(MAX_PAGE_AREA);
    }
  });

  it('returns an empty plan for no input', () => {
    expect(planPages([])).toEqual([]);
  });
});
