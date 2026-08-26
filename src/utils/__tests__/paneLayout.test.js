import { describe, it, expect } from 'vitest';
import {
  clampListPaneWidth,
  maxListPaneWidth,
  clampListPaneHeight,
  maxListPaneHeight,
  DIVIDER_WIDTH,
  MIN_LIST_WIDTH,
  MAX_LIST_WIDTH,
  MIN_VIEWER_WIDTH,
  MIN_LIST_HEIGHT,
  MIN_VIEWER_HEIGHT,
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

// The stacked layout divides the same row on the other axis. It used to read
// the *width* preference as a height with no clamp of its own, so a legal
// 600px list width became a 600px list height: in the app's own 600px-minimum
// window the divider sat at y=600 and the reading pane at y=604, both below
// the fold of a box that clips its overflow. Selecting a message rendered
// nothing, and the divider that would undo it was off-screen too.
const COLUMN_FITS = (list, available) => list + DIVIDER_WIDTH + MIN_VIEWER_HEIGHT <= available;

describe('paneLayout — stacked (two-column) heights', () => {
  it('keeps the divider and the reader on-screen at the app\'s minimum window', () => {
    // 600x600 is the Tauri window's minHeight; 600 was a legal list *width*.
    const height = clampListPaneHeight(600, 600);
    expect(COLUMN_FITS(height, 600)).toBe(true);
    expect(height).toBeLessThan(600);
  });

  it('keeps the column within the window across the whole usable range', () => {
    for (let available = MIN_LIST_HEIGHT + DIVIDER_WIDTH + MIN_VIEWER_HEIGHT; available <= 2000; available += 7) {
      expect(COLUMN_FITS(clampListPaneHeight(9999, available), available)).toBe(true);
    }
  });

  it('honours a user height that already fits', () => {
    expect(clampListPaneHeight(320, 900)).toBe(320);
  });

  it('does not borrow the width cap — a tall window may hold a tall list', () => {
    expect(maxListPaneHeight(1600)).toBeGreaterThan(MAX_LIST_WIDTH);
  });

  it('never returns less than MIN_LIST_HEIGHT, even when the window cannot hold it', () => {
    expect(clampListPaneHeight(10, 100)).toBe(MIN_LIST_HEIGHT);
    expect(maxListPaneHeight(100)).toBe(MIN_LIST_HEIGHT);
  });
});
