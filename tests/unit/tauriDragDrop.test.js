import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

// Compose file drops depend on ONE invisible config line. With Tauri's native
// drag-drop handler enabled, wry answers AppKit itself, reads plain paths off
// the pasteboard, and the compose window receives `tauri://drag-drop` — the
// path src/utils/nativeDrop.js and ComposeModal's native-drop effect handle.
// Turn it off and a file drag goes to WebKit's HTML5 path instead, which on
// macOS receives a screenshot thumbnail as a file PROMISE and lost every second
// one (2026-09-03) — while every synthetic drop spec stays green, because none
// of them crosses the native layer. This is the only check that goes red when
// someone "tidies" the flag away.
describe('tauri.conf.json', () => {
  it('keeps native drag-drop enabled so file drops bypass WebKit\'s promise handling', () => {
    const conf = JSON.parse(readFileSync(new URL('../../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
    for (const win of conf.app.windows) {
      expect(win.dragDropEnabled).toBe(true);
    }
  });
});
