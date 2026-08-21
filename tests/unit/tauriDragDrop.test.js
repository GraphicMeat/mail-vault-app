import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

// Compose drag-and-drop depends on ONE invisible config line. With Tauri's
// native drag-drop handler enabled (the default), tauri-runtime-wry consumes
// every Finder drop before WebKit sees it, so no HTML5 `drop` event ever
// fires — and every e2e spec stays green, because they dispatch synthetic
// drop events that never cross the native layer. This is the only check that
// goes red when someone "tidies" the flag away.
describe('tauri.conf.json', () => {
  it('keeps native drag-drop disabled so HTML5 file drops reach the compose window', () => {
    const conf = JSON.parse(readFileSync(new URL('../../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
    for (const win of conf.app.windows) {
      expect(win.dragDropEnabled).toBe(false);
    }
  });
});
