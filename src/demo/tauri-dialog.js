import { demoBackend } from './runtime.js';

export async function save(options = {}) {
  const requested = String(options.defaultPath || 'mailvault-demo-export');
  const filename = requested.split(/[\\/]/).pop() || 'mailvault-demo-export';
  // Export uses the returned path only as a stable label; save_attachment_to
  // turns the bytes into an ordinary browser download.
  return `browser-downloads/${filename}`;
}

export async function open(options = {}) {
  if (options.directory) return 'browser-downloads';
  const extensions = (options.filters || []).flatMap(filter => filter.extensions || []).map(ext => String(ext).toLowerCase());
  if (extensions.includes('zip')) return 'browser-sample/mailvault-demo-backup.zip';
  if (extensions.includes('mbox')) return 'browser-sample/mailvault-demo.mbox';
  throw new demoBackend.DemoUnsupportedError('native_open_dialog');
}

export async function ask() { return false; }
export async function confirm() { return false; }
export async function message() { return undefined; }
