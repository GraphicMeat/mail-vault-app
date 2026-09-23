// A window reload right after a setState must not lose it: safeStorage's
// normal write is debounced 500ms and fire-and-forget, so callers that reload
// (account transfer import) await flushSafeStorage() instead.
import { describe, it, expect, vi } from 'vitest';

const writes = [];
let releaseWrite;
let failNextWrite = false;
const invoke = vi.fn((cmd, args) => {
  if (cmd === 'read_settings_json') return Promise.resolve('{}');
  if (cmd === 'write_settings_json') {
    if (failNextWrite) { failNextWrite = false; return Promise.reject('Failed to write settings: disk full'); }
    return new Promise((resolve) => { releaseWrite = () => { writes.push(JSON.parse(args.data)); resolve(); }; });
  }
  return Promise.resolve();
});
globalThis.window = { __TAURI__: { core: { invoke } }, location: { search: '' } };

const { safeStorage, flushSafeStorage } = await import('../safeStorage');

describe('flushSafeStorage', () => {
  it('writes pending state now and resolves only after the disk write completes', async () => {
    await safeStorage.getItem('mailvault-settings');
    safeStorage.setItem('mailvault-settings', JSON.stringify({ state: { undoSendDelay: 30 }, version: 7 }));
    safeStorage.setItem('mailvault-theme', JSON.stringify({ state: { theme: 'light' } }));

    let done = false;
    const flushed = flushSafeStorage().then(() => { done = true; });
    await vi.waitFor(() => expect(releaseWrite).toBeTypeOf('function'));
    expect(done).toBe(false);
    releaseWrite();
    await flushed;

    expect(writes).toEqual([{
      'mailvault-settings': { state: { undoSendDelay: 30 }, version: 7 },
      'mailvault-theme': { state: { theme: 'light' } },
    }]);
  });

  it('rejects when the write fails, so an import can report it', async () => {
    safeStorage.setItem('mailvault-theme', JSON.stringify({ state: { theme: 'dark' } }));
    failNextWrite = true;
    await expect(flushSafeStorage()).rejects.toBe('Failed to write settings: disk full');
  });

  it('keeps the debounced write rejection-free (warns only)', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      failNextWrite = true;
      safeStorage.setItem('mailvault-theme', JSON.stringify({ state: { theme: 'light' } }));
      await vi.advanceTimersByTimeAsync(600);
      expect(warn).toHaveBeenCalledWith('[safeStorage] Failed to write settings:', 'Failed to write settings: disk full');
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });
});
