import { demoFiles } from './runtime.js';

export const BaseDirectory = Object.freeze({ AppData: 'AppData', AppCache: 'AppCache', Home: 'Home', Download: 'Download' });

// db/accounts.js hands absolute paths under get_app_data_dir (backend.js: '/demo/app-data').
const pathOf = (path = '') => String(path).replace(/^\/demo\/app-data\//, '').replace(/^\.\//, '').replace(/^Maildir\//, 'Maildir/');

export async function readTextFile(path) {
  const value = demoFiles.read(pathOf(path));
  if (value == null) throw new Error(`Demo file does not exist: ${path}`);
  return value;
}

export async function writeTextFile(path, data) {
  demoFiles.write(pathOf(path), data);
}

export async function exists(path) {
  return demoFiles.exists(pathOf(path));
}

export async function mkdir() {}
export async function remove(path) { demoFiles.write(pathOf(path), ''); }
export async function readDir(path = '') { return demoFiles.list(pathOf(path)); }
