import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { manifest } from './source-manifest.mjs';

const root = process.cwd();
const files = manifest(root);
const staging = mkdtempSync(join(tmpdir(), 'mv-insights-source-'));
const destination = '/Users/unicorn/Repos/mv-insights-20260909-01a08694';
try {
  for (const path of Object.keys(files)) {
    mkdirSync(dirname(join(staging, path)), { recursive: true });
    copyFileSync(join(root, path), join(staging, path));
  }
  writeFileSync(join(staging, '.insights-source-manifest.json'), JSON.stringify(files, null, 2));
  execFileSync('rsync', ['-a', `${staging}/`, `macmini:${destination}/`], { stdio: 'inherit' });
  execFileSync('ssh', ['macmini', `/opt/homebrew/opt/node@24/bin/node --input-type=commonjs -`], {
    input: `const fs=require('fs'),crypto=require('crypto'); const root=${JSON.stringify(destination)}; const m=JSON.parse(fs.readFileSync(root+'/.insights-source-manifest.json')); for(const [p,h] of Object.entries(m)) { if(crypto.createHash('sha256').update(fs.readFileSync(root+'/'+p)).digest('hex')!==h) throw Error('Source mismatch: '+p); } console.log('Source parity: '+Object.keys(m).length+' files');`,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
} finally { rmSync(staging, { recursive: true, force: true }); }
