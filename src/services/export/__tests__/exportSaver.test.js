import { describe, it, expect, vi, beforeEach } from 'vitest';

const save = vi.fn();
const open = vi.fn();
const shellOpen = vi.fn(() => Promise.resolve());
const invoke = vi.fn(() => Promise.resolve('/written/path'));

vi.mock('@tauri-apps/plugin-dialog', () => ({ save: (...a) => save(...a), open: (...a) => open(...a) }));
vi.mock('@tauri-apps/plugin-shell', () => ({ open: (...a) => shellOpen(...a) }));
vi.mock('@tauri-apps/api/path', () => ({
  appCacheDir: async () => '/cache',
  join: async (...p) => p.join('/'),
  dirname: async (p) => p.slice(0, p.lastIndexOf('/')),
  basename: async (p) => p.slice(p.lastIndexOf('/') + 1),
}));

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
    expect(out).toEqual({ path: '/Users/rokas/Desktop/shot.png', failed: [] });
  });

  it('writes nothing when the dialog is cancelled', async () => {
    save.mockResolvedValue(null);
    expect(await saveOneFile(file, 'Export Image')).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });
});

// Attachments ride along beside the image, named after the file the user
// actually picked — not after the name the dialog suggested, which they are
// free to change in the panel.
describe('saveOneFile with attachments beside it', () => {
  const sidecars = [{ name: 'invoice.pdf', base64: 'PDF' }, { name: 'photo.png', base64: 'PNG' }];

  it('writes each one beside the chosen file, under the chosen stem', async () => {
    save.mockResolvedValue('/d/My export.png');
    const out = await saveOneFile(file, 'Export Image', sidecars);
    expect(invoke.mock.calls.map(c => c[1].destPath)).toEqual([
      '/d/My export.png', '/d/My export - invoice.pdf', '/d/My export - photo.png',
    ]);
    expect(out).toEqual({ path: '/d/My export.png', failed: [] });
  });

  it('writes nothing at all when the dialog is cancelled', async () => {
    save.mockResolvedValue(null);
    expect(await saveOneFile(file, 't', sidecars)).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('names the attachment that would not write, and still reports the file', async () => {
    save.mockResolvedValue('/d/shot.png');
    invoke.mockResolvedValueOnce('/d/shot.png').mockRejectedValueOnce(new Error('disk full'));
    const out = await saveOneFile(file, 't', sidecars);
    expect(out.path).toBe('/d/shot.png');
    expect(out.failed).toEqual(['invoice.pdf']);
  });

  // An attachment is an extra; the export itself is not. A file that never
  // reached disk must not come back as a path the dialog then calls a success.
  it('still throws when the file itself cannot be written', async () => {
    save.mockResolvedValue('/d/shot.png');
    invoke.mockRejectedValueOnce(new Error('read-only volume'));
    await expect(saveOneFile(file, 't', sidecars)).rejects.toThrow(/read-only/);
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
    expect(invoke).toHaveBeenCalledWith('open_file', { path: '/cache/mailvault-export/shot.png' });
  });

  // shell:allow-open validates its argument against a URL pattern, so a file
  // path handed to the shell plugin is rejected and the button does nothing.
  // That is the bug this test exists to keep fixed.
  it('never routes a file path through the shell plugin', async () => {
    await openInDefaultApp(file);
    expect(shellOpen).not.toHaveBeenCalled();
  });
});

// The e2e seam exists because WebDriver cannot drive a native save panel. Both
// directions are asserted: a shipped build must never read the override, and
// an e2e build must never open the panel.
describe('the e2e destination seam', () => {
  it('is inert in a normal build — the panel still decides', async () => {
    window.__MV_EXPORT_DEST__ = '/forced/path.png';
    save.mockResolvedValue('/picked/path.png');
    const out = await saveOneFile(file, 't');
    expect(save).toHaveBeenCalled();
    expect(out.path).toBe('/picked/path.png');
    delete window.__MV_EXPORT_DEST__;
  });

  it('takes the injected path and opens no panel when built for e2e', async () => {
    vi.stubEnv('VITE_E2E', '1');
    vi.resetModules();
    const { saveOneFile: e2eSaveOneFile } = await import('../exportSaver');
    window.__MV_EXPORT_DEST__ = '/forced/path.png';

    const out = await e2eSaveOneFile(file, 't');

    expect(save).not.toHaveBeenCalled();
    expect(out.path).toBe('/forced/path.png');
    // By name, not by position: a fresh module graph (resetModules above) also
    // replays settingsStore's own read_settings_json through this same invoke.
    expect(invoke.mock.calls.find(c => c[0] === 'save_attachment_to')[1].destPath)
      .toBe('/forced/path.png');

    delete window.__MV_EXPORT_DEST__;
    vi.unstubAllEnvs();
    vi.resetModules();
  });
});
