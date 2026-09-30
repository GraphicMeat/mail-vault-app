/**
 * Tauri merges tauri.windows.conf.json over tauri.conf.json with JSON Merge
 * Patch, which REPLACES arrays: the Windows file carries a full copy of the
 * main window. It may differ in size only, or a later edit to the main
 * config silently stops reaching Windows.
 *
 * The size is smaller so the window opens above the taskbar on a 1920x1080
 * screen at the 150% scaling Windows picks for most such panels: 1280 x 720
 * logical, minus a 48px taskbar, leaves a 1280 x 672 work area. Higher
 * scaling is handled at startup by fit_main_window_to_work_area in main.rs.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const main = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8')).app.windows;
const win = JSON.parse(readFileSync('src-tauri/tauri.windows.conf.json', 'utf8')).app.windows;

const WORK_AREA_1080P_150 = { width: 1280, height: 672 };

describe('Windows main window config', () => {
  it('is the main window, differing only in size', () => {
    expect(win).toHaveLength(main.length);
    expect({ ...win[0], width: main[0].width, height: main[0].height }).toEqual(main[0]);
  });

  it('fits a 1080p screen at 150% scaling, above the taskbar', () => {
    expect(win[0].width).toBeLessThanOrEqual(WORK_AREA_1080P_150.width);
    expect(win[0].height).toBeLessThanOrEqual(WORK_AREA_1080P_150.height);
  });

  it('opens no smaller than its minimum size', () => {
    expect(win[0].width).toBeGreaterThanOrEqual(win[0].minWidth);
    expect(win[0].height).toBeGreaterThanOrEqual(win[0].minHeight);
  });
});
