/**
 * Tauri merges tauri.windows.conf.json over tauri.conf.json with JSON Merge
 * Patch, which REPLACES arrays: the Windows file carries a full copy of the
 * main window. It may differ in height only, or a later edit to the main
 * config silently stops reaching Windows.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const main = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8')).app.windows;
const win = JSON.parse(readFileSync('src-tauri/tauri.windows.conf.json', 'utf8')).app.windows;

describe('Windows main window config', () => {
  it('is the main window, 100px shorter', () => {
    expect(win).toHaveLength(main.length);
    expect(win[0].height).toBe(main[0].height - 100);
    expect({ ...win[0], height: main[0].height }).toEqual(main[0]);
  });
});
