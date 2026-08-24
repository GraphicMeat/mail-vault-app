import { describe, it, expect } from 'vitest';
import {
  clampListPaneWidth,
  maxListPaneWidth,
  DIVIDER_WIDTH,
  MIN_LIST_WIDTH,
  MAX_LIST_WIDTH,
  MIN_VIEWER_WIDTH,
} from '../paneLayout';

// The row is sidebar | list | divider | viewer. The list is flex-shrink-0, so
// any width the clamp lets through that the row cannot hold becomes horizontal
// overflow of the whole app — and that overflow is what let a text selection
// drag the sidebar and the list off-screen for good.
const ROW_FITS = (list, available) => list + DIVIDER_WIDTH + MIN_VIEWER_WIDTH <= available;

describe('paneLayout', () => {
  it('leaves room for the divider, not just the viewer', () => {
    // Exactly enough for the smallest list + divider + viewer, and no more.
    const available = MIN_LIST_WIDTH + DIVIDER_WIDTH + MIN_VIEWER_WIDTH;
    expect(maxListPaneWidth(available)).toBe(MIN_LIST_WIDTH);
    expect(ROW_FITS(clampListPaneWidth(9999, available), available)).toBe(true);
  });

  it('keeps the row within the window across the whole usable range', () => {
    for (let available = MIN_LIST_WIDTH + DIVIDER_WIDTH + MIN_VIEWER_WIDTH; available <= 2000; available += 7) {
      const width = clampListPaneWidth(9999, available);
      expect(ROW_FITS(width, available)).toBe(true);
    }
  });

  it('caps the list at MAX_LIST_WIDTH on a wide window', () => {
    expect(maxListPaneWidth(4000)).toBe(MAX_LIST_WIDTH);
    expect(clampListPaneWidth(9999, 4000)).toBe(MAX_LIST_WIDTH);
  });

  it('honours a user width that already fits', () => {
    expect(clampListPaneWidth(420, 1400)).toBe(420);
  });

  it('never returns less than MIN_LIST_WIDTH, even when the window cannot hold it', () => {
    // Below the floor the row genuinely does not fit; the list still may not
    // collapse to nothing, so overflow is unavoidable here — which is exactly
    // why the clipping ancestors must be `overflow: clip` (see the e2e spec).
    expect(clampListPaneWidth(10, 100)).toBe(MIN_LIST_WIDTH);
    expect(maxListPaneWidth(100)).toBe(MIN_LIST_WIDTH);
  });
});
