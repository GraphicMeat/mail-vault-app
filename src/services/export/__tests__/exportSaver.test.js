import { describe, it, expect, vi, beforeEach } from 'vitest';

const save = vi.fn();
const open = vi.fn();
const shellOpen = vi.fn(() => Promise.resolve());
const invoke = vi.fn(() => Promise.resolve('/written/path'));

vi.mock('@tauri-apps/plugin-dialog', () => ({ save: (...a) => save(...a), open: (...a) => open(...a) }));
vi.mock('@tauri-apps/plugin-shell', () => ({ open: (...a) => shellOpen(...a) }));
vi.mock('@tauri-apps/api/path', () => ({ appCacheDir: async () => '/cache', join: async (...p) => p.join('/') }));

const { saveOneFile, saveFilesToDirectory, openInDefaultApp } = await import('../exportSaver');

const file = { name: 'shot.png', base64: 'AAAA' };

beforeEach(() => {
  save.mockReset(); open.mockReset(); shellOpen.mockClear(); invoke.mockClear();
  invoke.mockResolvedValue('/written/path');
  globalThis.window = globalThis.window || {};
  window.__TAURI__ = { core: { invoke: (...a) => invoke(...a) } };
});

describe('saveOneFile', () => {
  it('offers the generated name as the default and writes the chosen path', async () => {
    save.mockResolvedValue('/Users/rokas/Desktop/shot.png');
    const out = await saveOneFile(file, 'Export Image');
    expect(save.mock.calls[0][0]).toMatchObject({ defaultPath: 'shot.png', title: 'Export Image' });
    expect(invoke).toHaveBeenCalledWith('save_attachment_to', {
      filename: 'shot.png', contentBase64: 'AAAA', destPath: '/Users/rokas/Desktop/shot.png',
    });
    expect(out).toBe('/Users/rokas/Desktop/shot.png');
  });

  it('writes nothing when the dialog is cancelled', async () => {
    save.mockResolvedValue(null);
    expect(await saveOneFile(file, 'Export Image')).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('saveFilesToDirectory', () => {
  it('asks for a directory and writes every file into it', async () => {
    open.mockResolvedValue('/Users/rokas/Desktop/thread');
    const files = [{ name: 'a.png', base64: 'A' }, { name: 'b.png', base64: 'B' }];
    const out = await saveFilesToDirectory(files, 'Export Thread');
    expect(open.mock.calls[0][0]).toMatchObject({ directory: true });
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[1][1].destPath).toBe('/Users/rokas/Desktop/thread/b.png');
    expect(out).toEqual({ dir: '/Users/rokas/Desktop/thread', written: 2 });
  });

  it('writes nothing when the picker is cancelled', async () => {
    open.mockResolvedValue(null);
    expect(await saveFilesToDirectory([file], 'Export Thread')).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('reports how many were written when one write fails', async () => {
    open.mockResolvedValue('/dir');
    invoke.mockResolvedValueOnce('/dir/a.png').mockRejectedValueOnce(new Error('disk full'));
    const out = await saveFilesToDirectory([{ name: 'a.png', base64: 'A' }, { name: 'b.png', base64: 'B' }], 't');
    expect(out.written).toBe(1);
    expect(out.failed).toEqual(['b.png']);
  });
});

describe('openInDefaultApp', () => {
  it('writes into the cache dir and hands the path to the OS', async () => {
    await openInDefaultApp(file);
    expect(invoke.mock.calls[0][1].destPath).toBe('/cache/mailvault-export/shot.png');
    expect(shellOpen).toHaveBeenCalledWith('/cache/mailvault-export/shot.png');
  });
});
