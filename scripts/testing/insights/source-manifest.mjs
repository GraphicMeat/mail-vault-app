import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, lstatSync } from 'node:fs';

export function manifest(root = process.cwd()) {
  const paths = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root }).toString().split('\0');
  paths.push('docs/superpowers/plans/2026-09-09-mail-insights.md', 'docs/superpowers/specs/2026-09-09-mail-insights-design.md');
  const excluded = /(^|\/)(\.git|\.claude|\.codex|\.agents|\.superpowers|node_modules|target|dist)(\/|$)|(^|\/)\.env|signing-config\.sh$|^src-tauri\/gen\/|^website\/api\/|^screenshots\//;
  return Object.fromEntries([...new Set(paths)].filter(p => p && !excluded.test(p) && existsSync(`${root}/${p}`) && lstatSync(`${root}/${p}`).isFile()).sort().map(p => [p, createHash('sha256').update(readFileSync(`${root}/${p}`)).digest('hex')]));
}
if (process.argv[1]?.endsWith('source-manifest.mjs')) console.log(JSON.stringify(manifest(), null, 2));
