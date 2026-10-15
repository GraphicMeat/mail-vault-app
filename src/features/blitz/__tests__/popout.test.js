import { describe, it, expect, vi } from 'vitest';
import { openBlitzWindow, installWindowDocCleanup } from '../surfaces/popout';

describe('openBlitzWindow', () => {
  it('opens the original window and hands it the body on its ready event', async () => {
    let handler; const stop = vi.fn();
    const deps = {
      uuid: () => 'tok-1',
      listen: vi.fn(async (_name, fn) => { handler = fn; return stop; }),
      emitTo: vi.fn(async () => {}),
      invoke: vi.fn(async () => 'original-4'),
    };
    const label = await openBlitzWindow({ html: '<p>B</p>', dark: true, title: 'Hi' }, deps);
    expect(label).toBe('original-4');
    expect(deps.invoke).toHaveBeenCalledWith('open_auxiliary_window', { kind: 'original', token: 'tok-1' });
    await handler({ payload: { token: 'other', label: 'original-9' } });
    expect(deps.emitTo).not.toHaveBeenCalled();
    await handler({ payload: { token: 'tok-1', label: 'original-4' } });
    expect(deps.emitTo).toHaveBeenCalledWith('original-4', 'original-message-payload', { token: 'tok-1', html: '<p>B</p>', dark: true, title: 'Hi', surface: 'popout' });
    expect(stop).toHaveBeenCalled();
  });

  it('a window that fails to open stops listening and rethrows', async () => {
    const stop = vi.fn();
    const deps = { uuid: () => 't', listen: vi.fn(async () => stop), emitTo: vi.fn(), invoke: vi.fn(async () => { throw new Error('nope'); }) };
    await expect(openBlitzWindow({ html: '', dark: false, title: '' }, deps)).rejects.toThrow('nope');
    expect(stop).toHaveBeenCalled();
  });
});

describe('installWindowDocCleanup (Review Focus 5, F21)', () => {
  it('holds the close until the docs closed, then lets it go on', async () => {
    let onClose;
    const win = { onCloseRequested: vi.fn(async (fn) => { onClose = fn; return () => {}; }) };
    let finish;
    const registry = { closeAll: vi.fn(() => new Promise((r) => { finish = r; })) };
    await installWindowDocCleanup(registry, { win, waitMs: 1000 });
    const calls = [];
    const event = { preventDefault: vi.fn(() => calls.push('prevent')) };
    win.destroy = vi.fn(async () => { calls.push('destroy'); });
    const pending = onClose(event);
    await Promise.resolve();
    expect(registry.closeAll).toHaveBeenCalledWith({ waitMs: 1000 });
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(win.destroy).not.toHaveBeenCalled();
    finish(3);
    await pending;
    expect(win.destroy).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['prevent', 'destroy']);
  });

  it('still destroys the window when the cleanup throws', async () => {
    let onClose;
    const win = { onCloseRequested: vi.fn(async (fn) => { onClose = fn; return () => {}; }), destroy: vi.fn(async () => {}) };
    const registry = { closeAll: vi.fn(async () => { throw new Error('boom'); }) };
    await installWindowDocCleanup(registry, { win });
    await onClose({ preventDefault: vi.fn() });
    expect(win.destroy).toHaveBeenCalledTimes(1);
  });

  it('a second close request during the cleanup does not destroy twice', async () => {
    let onClose; let finish;
    const win = { onCloseRequested: vi.fn(async (fn) => { onClose = fn; return () => {}; }), destroy: vi.fn(async () => {}) };
    const registry = { closeAll: vi.fn(() => new Promise((r) => { finish = r; })) };
    await installWindowDocCleanup(registry, { win });
    const a = onClose({ preventDefault: vi.fn() });
    const b = onClose({ preventDefault: vi.fn() });
    finish(0);
    await Promise.all([a, b]);
    expect(win.destroy).toHaveBeenCalledTimes(1);
    expect(registry.closeAll).toHaveBeenCalledTimes(1);
  });
});
