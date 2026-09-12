const normalize = value => String(value || '').replaceAll('\\', '/');
export async function join(...parts) { return parts.map(normalize).join('/').replace(/\/+/g, '/'); }
export async function dirname(path) { const value = normalize(path); return value.slice(0, Math.max(0, value.lastIndexOf('/'))); }
export async function basename(path) { return normalize(path).split('/').pop() || ''; }
export async function appCacheDir() { return '/demo-cache'; }
