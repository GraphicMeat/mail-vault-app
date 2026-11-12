#!/usr/bin/env node
// Writes src/services/rpcMethods.generated.js from src-daemon/methods.json,
// the list of every RPC method the daemon answers with its reply budget
// (src-daemon/src/rpc_registry.rs keeps it equal to its table; a Rust test
// checks that). Only the names reach the frontend.
//
//   node scripts/gen-rpc-methods.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const rows = JSON.parse(readFileSync(join(root, 'src-daemon', 'methods.json'), 'utf8'));

if (!Array.isArray(rows) || rows.some((r) => typeof r?.name !== 'string')) {
  throw new Error('src-daemon/methods.json must be an array of {name, replySecs} rows');
}
const names = rows.map((r) => r.name);

const body = names.map((n) => `  ${JSON.stringify(n)},`).join('\n');
const out = `// generated, do not edit, run node scripts/gen-rpc-methods.mjs
export const RPC_METHODS = Object.freeze([
${body}
]);
`;

writeFileSync(join(root, 'src', 'services', 'rpcMethods.generated.js'), out);
console.log(`wrote ${names.length} methods`);
