import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const built=JSON.parse(readFileSync('.insights-build-manifest.json'));
const current=JSON.parse(readFileSync('.insights-source-manifest.json'));
const compiled=path=>/^(src\/|src-core\/|src-daemon\/|src-tauri\/|Cargo\.|package[^/]*\.json$|vite\.config)/.test(path);
const changed=Object.keys({...built,...current}).filter(compiled).filter(path=>built[path]!==current[path] || (current[path] && createHash('sha256').update(readFileSync(path)).digest('hex')!==current[path]));
if(changed.length)throw new Error(`Native app must be rebuilt after source changes: ${changed.join(', ')}`);
console.log('Native build source matches current source manifest');
