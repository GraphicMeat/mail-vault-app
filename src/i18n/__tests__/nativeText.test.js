import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import en from '../locales/en.json';

const ROOT = process.cwd();
const RUST_DIR = resolve(ROOT, 'src-tauri/src');
const rustFiles = readdirSync(RUST_DIR).filter(f => f.endsWith('.rs')).map(f => join(RUST_DIR, f));
const rust = rustFiles.map(f => [f, readFileSync(f, 'utf8')]);
const pushSource = readFileSync(resolve(ROOT, 'src/i18n/index.js'), 'utf8');

// Rust source holds `\n` as two characters; the catalog holds a real newline.
const fromRust = (s) => s.replace(/\\n/g, '\n');

// `native_text(&handle, "dlg_snap", "English fallback")`
const NATIVE_TEXT = /native_text\(\s*&\w+,\s*"(\w+)",\s*"((?:[^"\\]|\\.)*)"\s*\)/g;
const uses = rust.flatMap(([file, src]) => [...src.matchAll(NATIVE_TEXT)].map(([, id, english]) => ({ file, id, english: fromRust(english) })));

// Keys the frontend pushes under a window id: `win_x: 'some.key'`.
const windowKeys = Object.fromEntries([...pushSource.matchAll(/(win_\w+):\s*'([^']+)'/g)].map(([, id, key]) => [id, key]));
const menuIds = new Set([...(pushSource.match(/const MENU_IDS = \[([\s\S]*?)\];/)?.[1] ?? '').matchAll(/'(\w+)'/g)].map(m => m[1]));

describe('text the Rust shell shows natively', () => {
  it('has no literal dialog message or window title the catalog cannot translate', () => {
    const literal = /\.(?:title|message)\(\s*(?:format!\(\s*)?"/;
    const found = rust.flatMap(([file, src]) => src.split('\n')
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => !/^\s*\/\//.test(line) && literal.test(line))
      .map(({ line, n }) => `${file.slice(ROOT.length + 1)}:${n}: ${line.trim().slice(0, 80)}`));
    expect(found).toEqual([]);
  });

  it('finds the call sites it is guarding', () => {
    expect(uses.length).toBeGreaterThanOrEqual(15);
  });

  it('is pushed by the frontend for every id the shell reads', () => {
    const unpushed = uses.filter(({ id }) => !(menuIds.has(id) || id in windowKeys)).map(({ id }) => id);
    expect([...new Set(unpushed)]).toEqual([]);
  });

  it('has a catalog entry behind every id the frontend pushes', () => {
    const missing = [
      ...[...menuIds].filter(id => id.startsWith('dlg_')).map(id => `menu.${id}`),
      ...Object.values(windowKeys),
    ].filter(key => !(key in en));
    expect(missing).toEqual([]);
  });

  it('falls back to exactly the English the catalog holds', () => {
    const drifted = uses.flatMap(({ id, english }) => {
      const key = id in windowKeys ? windowKeys[id] : `menu.${id}`;
      return en[key] === english ? [] : [`${id}: "${english}" != "${en[key]}"`];
    });
    expect(drifted).toEqual([]);
  });
});
