// @vitest-environment node
// The phone's buttons are desktop's Button (src/components/ui/Button.jsx, size `touch`), not
// hand-rolled classes: no phone file uses the old button classes, mobile.css keeps no rule for
// them, and the phone's own layers give Button the preflight it is drawn for, at zero specificity
// so no phone rule changes weight.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const walk = (dir) => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  if (statSync(p).isDirectory()) return f === '__tests__' ? [] : walk(p);
  return /\.jsx?$/.test(f) ? [p] : [];
});
const sources = walk(root).map((p) => [p.slice(root.length), readFileSync(p, 'utf8')]);
const css = readFileSync(new URL('../mobile.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

const RETIRED = [
  'mv-primary', 'mv-premium__primary', 'mv-compose__send', 'mv-outbox__btn', 'mv-search__server-btn',
  'mv-textbtn', 'mv-reauth__btn', 'mv-search__link', 'mv-compose__more', 'mv-premium__linkbtn',
  'mv-iconbtn', 'mv-qr__dismiss', 'mv-acct__reauth', 'mv-tour__later', 'mv-schedule__confirm',
  'mv-compose__back',
];
const used = (cls) => new RegExp(`(?<![\\w-])${cls}(?![\\w-])`);

describe('phone buttons are desktop Button', () => {
  it('no phone file uses a retired button class', () => {
    const hits = [];
    for (const [file, src] of sources) for (const cls of RETIRED) if (used(cls).test(src)) hits.push(`${file}: ${cls}`);
    expect(hits).toEqual([]);
  });

  it('mobile.css has no rule left for them', () => {
    const left = RETIRED.filter((cls) => new RegExp(`\\.${cls}(?![\\w-])`).test(css));
    expect(left).toEqual([]);
    expect(css).not.toMatch(/\.mv-status button/);
  });

  it("the phone's layers give a button the preflight Button is drawn for, at zero specificity", () => {
    const base = css.match(/:where\(([^)]*)\)\s*:where\(button\)\s*\{([^}]*)\}/);
    expect(base).toBeTruthy();
    const layers = base[1].split(',').map((s) => s.trim());
    for (const layer of ['.mv-kb-layer', '.mv-overlay', '.mv-toasts', '.mv-viewer', '.mv-thread', '.mv-drafts']) {
      expect(layers).toContain(layer);
    }
    for (const decl of ['box-sizing: border-box', 'border: 0 solid var(--mail-border)', 'background: none', 'padding: 0', 'font: inherit', 'color: inherit']) {
      expect(base[2]).toContain(decl);
    }
  });

  it('the phone renders Button at the touch size', () => {
    const files = sources.filter(([, src]) => /components\/ui\/Button/.test(src) && /size="touch"/.test(src));
    expect(files.length).toBeGreaterThan(10);
    const compose = sources.find(([f]) => f === 'Compose.jsx')[1];
    // Send: the primary Button (accent-fill, 8px corners), its busy look and hook kept.
    expect(compose).toMatch(/<Button\s+variant="primary"\s+size="touch"[^<]{0,400}?data-mv-send/);
    expect(compose).toMatch(/mv-send--busy/);
    expect(css).toMatch(/\.mv-send--busy:disabled \{[^}]*opacity: 1/);
  });
});
