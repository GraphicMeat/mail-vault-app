// Writing bytes is already solved: save_attachment_to takes a base64 payload
// and a destination the user picked. Nothing new goes into Rust for this.

import { sidecarName } from './exportNaming';

const CACHE_SUBDIR = 'mailvault-export';

// WebDriver cannot drive a native macOS save panel, so under VITE_E2E the
// destination is injected instead of picked. Inert in a shipped build: the
// flag is compiled out, and the globals only exist while a spec sets them.
const E2E = Boolean(import.meta.env?.VITE_E2E);
const injectedPath = () => (E2E ? (globalThis.window?.__MV_EXPORT_DEST__ ?? null) : null);
const injectedDir = () => (E2E ? (globalThis.window?.__MV_EXPORT_DIR__ ?? null) : null);

async function writeFile(file, destPath) {
  const { invoke } = window.__TAURI__.core;
  return invoke('save_attachment_to', {
    filename: file.name,
    contentBase64: file.base64,
    destPath,
  });
}

// Attachments land beside the export, named after the file the user actually
// picked — not after the name the dialog offered, which the save panel lets
// them rewrite. `extname` is deliberately not used: it rejects a path with no
// extension at all, and the attachments must still land beside that file.
async function writeSidecars(sidecars, destPath) {
  if (!sidecars.length) return [];
  const { dirname, basename, join } = await import('@tauri-apps/api/path');
  const dir = await dirname(destPath);
  const picked = await basename(destPath);
  const dot = picked.lastIndexOf('.');
  const stem = dot > 0 ? picked.slice(0, dot) : picked;

  const failed = [];
  for (const sidecar of sidecars) {
    const name = sidecarName(stem, sidecar.name);
    try {
      await writeFile({ name, base64: sidecar.base64 }, await join(dir, name));
    } catch (err) {
      // One unwritable attachment is not a failed export. Name it and go on.
      console.error('[export] failed to write', name, err);
      failed.push(sidecar.name);
    }
  }
  return failed;
}

export async function saveOneFile(file, title, sidecars = []) {
  const forced = injectedPath();
  const destPath = forced ?? await (async () => {
    const { save } = await import('@tauri-apps/plugin-dialog');
    return save({ defaultPath: file.name, title });
  })();
  if (!destPath) return null;
  await writeFile(file, destPath);
  return { path: destPath, failed: await writeSidecars(sidecars, destPath) };
}

export async function saveFilesToDirectory(files, title) {
  const forcedDir = injectedDir();
  const dir = forcedDir ?? await (async () => {
    const { open } = await import('@tauri-apps/plugin-dialog');
    return open({ directory: true, multiple: false, title });
  })();
  if (!dir) return null;

  const { join } = await import('@tauri-apps/api/path');
  const failed = [];
  let written = 0;
  for (const file of files) {
    try {
      await writeFile(file, await join(dir, file.name));
      written += 1;
    } catch (err) {
      // One unwritable file is not a failed export. Name it and keep going.
      console.error('[export] failed to write', file.name, err);
      failed.push(file.name);
    }
  }
  return failed.length ? { dir, written, failed } : { dir, written };
}

// `open_file`, not the shell plugin: shell:allow-open validates its argument
// against the URL pattern (http/https/mailto/tel), so handing it a file path
// is rejected — which is why "Open" on a sample did nothing at all. The Rust
// command is the same one the attachment bar has always used.
export async function openInDefaultApp(file) {
  const { appCacheDir, join } = await import('@tauri-apps/api/path');
  const destPath = await join(await appCacheDir(), CACHE_SUBDIR, file.name);
  await writeFile(file, destPath);
  const { invoke } = window.__TAURI__.core;
  await invoke('open_file', { path: destPath });
  return destPath;
}
