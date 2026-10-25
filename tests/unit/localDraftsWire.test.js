import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
it('gives metadata reads and complete draft IO explicit shell reply budgets', () => {
  const source = readFileSync('src-tauri/src/main.rs', 'utf8');
  const table = source.slice(source.indexOf('fn reply_timeout('), source.indexOf('\n}', source.indexOf('fn reply_timeout(')));
  const budgets = new Map();
  for (const arm of table.matchAll(/((?:"[^"]+"\s*(?:\|\s*)?)+)=> Some\(Duration::from_secs\((\d+)\)\)/g)) {
    for (const name of arm[1].matchAll(/"([^"]+)"/g)) budgets.set(name[1], Number(arm[2]));
  }
  expect(Object.fromEntries(['drafts.save', 'drafts.list', 'drafts.discard'].map(method => [method, budgets.get(method)]))).toEqual({ 'drafts.save': 600, 'drafts.list': 120, 'drafts.discard': 120 });
});
