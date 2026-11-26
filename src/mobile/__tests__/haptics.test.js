// @vitest-environment jsdom
// The haptics seam: the official haptics plugin's commands through the global bridge, fire and
// forget. No shell (web, tests) is a no-op, and nothing ever throws or rejects into a caller.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { haptic, watchSwitchHaptics } from '../haptics.js';

let invoke;
beforeEach(() => {
  invoke = vi.fn(async () => undefined);
  window.__TAURI__ = { core: { invoke } };
});
afterEach(() => {
  delete window.__TAURI__;
  document.body.innerHTML = '';
});

describe('haptic', () => {
  it('selection calls the plugin with no arguments', () => {
    haptic.selection();
    expect(invoke).toHaveBeenCalledWith('plugin:haptics|selection_feedback');
  });

  it('impact passes its style, and an unknown style falls back to light', () => {
    haptic.impact('medium');
    haptic.impact('heavy');
    haptic.impact('nonsense');
    haptic.impact();
    expect(invoke.mock.calls).toEqual([
      ['plugin:haptics|impact_feedback', { style: 'medium' }],
      ['plugin:haptics|impact_feedback', { style: 'heavy' }],
      ['plugin:haptics|impact_feedback', { style: 'light' }],
      ['plugin:haptics|impact_feedback', { style: 'light' }],
    ]);
  });

  it('notify passes its type, and an unknown type falls back to success', () => {
    haptic.notify('error');
    haptic.notify('warning');
    haptic.notify('whatever');
    expect(invoke.mock.calls).toEqual([
      ['plugin:haptics|notification_feedback', { type: 'error' }],
      ['plugin:haptics|notification_feedback', { type: 'warning' }],
      ['plugin:haptics|notification_feedback', { type: 'success' }],
    ]);
  });

  it('returns nothing, so no caller can await it', () => {
    expect(haptic.selection()).toBeUndefined();
    expect(haptic.impact('light')).toBeUndefined();
    expect(haptic.notify('success')).toBeUndefined();
  });

  it('is a no-op without the shell', () => {
    delete window.__TAURI__;
    expect(() => { haptic.selection(); haptic.impact('light'); haptic.notify('error'); }).not.toThrow();
  });

  it('never throws or rejects when the plugin fails', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    invoke.mockRejectedValue(new Error('no haptics engine'));
    expect(() => haptic.selection()).not.toThrow();
    invoke.mockImplementation(() => { throw new Error('sync boom'); });
    expect(() => haptic.impact('heavy')).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });
});

describe('watchSwitchHaptics', () => {
  it('ticks once for a tap on any switch, and for nothing else', () => {
    const stop = watchSwitchHaptics();
    document.body.innerHTML = '<button role="switch" aria-checked="false" id="s"><i id="in"></i></button><button id="b">x</button>';
    document.getElementById('in').click();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('plugin:haptics|selection_feedback');
    document.getElementById('b').click();
    expect(invoke).toHaveBeenCalledTimes(1);
    stop();
    document.getElementById('s').click();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('skips a disabled switch', () => {
    const stop = watchSwitchHaptics();
    document.body.innerHTML = '<button role="switch" disabled id="s"></button><button role="switch" aria-disabled="true" id="t"></button>';
    document.getElementById('t').click();
    expect(invoke).not.toHaveBeenCalled();
    stop();
  });
});
