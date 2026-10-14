#!/usr/bin/env node
// Golden vectors for the Rust Dark Reader port (plan B Task 10). Bundles Dark
// Reader's own sources at tag v4.9.120 with esbuild, using the API build's
// defines (tasks/bundle-api.js: every __X__ false, @plus/* -> src/stubs/*),
// and evaluates them under the WebKit-iframe profile:
//   - navigator.userAgent of Tauri's WKWebView, with no "Safari" token, so
//     isSafari and isChromium are false;
//   - CSSLayerBlockRule defined, so isLayerRuleSupported is true;
//   - el.style.colorScheme is a string, so isCSSColorSchemePropSupported is
//     true and DEFAULT_THEME.styleSystemControls is false;
//   - isIFrame true (the reader's iframe).
// Prints the JSON between marker lines on stdout; logs go to stderr.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const TAG = 'v4.9.120';
const COMMIT = '90c39130c7b4c79068f26aaa596071c14e3425c4';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)';

const work = mkdtempSync(join(tmpdir(), 'dr-vectors-'));
const DR = join(work, 'darkreader');
execFileSync('git', ['clone', '--quiet', '--depth', '1', '--branch', TAG, 'https://github.com/darkreader/darkreader.git', DR], { stdio: ['ignore', 'ignore', 'inherit'] });
const head = execFileSync('git', ['-C', DR, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (head !== COMMIT) throw new Error(`tag ${TAG} is ${head}, expected ${COMMIT}`);
const version = JSON.parse(readFileSync(join(DR, 'package.json'), 'utf8')).version;

// Forward slashes and JSON quoting: on winbox (anyjob may route there) a raw
// backslash path inside this string would turn into escape sequences.
const src = (rel) => JSON.stringify(`${DR.replaceAll('\\', '/')}/src/${rel}`);
const entry = `
export * from ${src('inject/dynamic-theme/modify-colors.ts')};
export { parseColorWithCache, rgbToHSL, hslToRGB, rgbToString, rgbToHexString } from ${src('utils/color.ts')};
export { createFilterMatrix, applyColorMatrix } from ${src('generators/utils/matrix.ts')};
export { getSVGFilterMatrixValue } from ${src('generators/svg-filter.ts')};
export { getModifiableCSSDeclaration, getModifiedUserAgentStyle, getSelectionColor } from ${src('inject/dynamic-theme/modify-css.ts')};
export { getInlineOverrideStyle } from ${src('inject/dynamic-theme/inline-style.ts')};
export { clearColorPalette } from ${src('inject/dynamic-theme/palette.ts')};
export { variablesStore } from ${src('inject/dynamic-theme/variables.ts')};
export { DEFAULT_THEME } from ${src('defaults.ts')};
`;
const define = Object.fromEntries(['__DEBUG__', '__CHROMIUM_MV2__', '__CHROMIUM_MV3__', '__FIREFOX_MV2__', '__THUNDERBIRD__', '__TEST__', '__PLUS__', '__WATCH__', '__LOG__'].map((k) => [k, 'false']));
define.__PORT__ = '"-1"';
const out = await build({
  stdin: { contents: entry, resolveDir: DR, loader: 'ts' },
  bundle: true, format: 'esm', platform: 'neutral', write: false, define, logLevel: 'error',
  tsconfig: join(DR, 'src/tsconfig.json'),
  alias: { '@plus/utils/theme': join(DR, 'src/stubs/utils/theme.ts'), '@plus/defaults': join(DR, 'src/stubs/defaults.ts') },
});
const bundle = join(work, 'dr.mjs');
writeFileSync(bundle, out.outputFiles[0].text);

// WebKit-iframe profile shims, installed before the bundle evaluates.
Object.defineProperty(globalThis, 'navigator', { value: { userAgent: UA, platform: 'MacIntel' }, configurable: true });
globalThis.location = { hostname: 'localhost', origin: 'tauri://localhost', href: 'about:srcdoc', protocol: 'about:' };
globalThis.chrome = { runtime: { onMessage: { addListener() {} }, sendMessage() {} } };
globalThis.CSSLayerBlockRule = function CSSLayerBlockRule() {};
globalThis.document = {
  addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
  querySelector() { return null; }, querySelectorAll() { return []; },
  createElement() { return { style: { colorScheme: '' }, setAttribute() {}, getContext() { return null; } }; },
  documentElement: { style: {} }, head: null,
};
const m = await import(pathToFileURL(bundle).href);

const PALETTES = { indigo: ['#0a0a12', '#e8e8ef'], graphite: ['#121313', '#edece7'], teal: ['#0a1517', '#e6f1f2'] };
const themes = {};
for (const [name, [bg, fg]] of Object.entries(PALETTES)) {
  themes[name] = { ...m.DEFAULT_THEME, darkSchemeBackgroundColor: bg, darkSchemeTextColor: fg, brightness: 100, contrast: 100, sepia: 0 };
}
themes.tuned = { ...themes.indigo, brightness: 90, contrast: 110, sepia: 10, grayscale: 20 };
if (themes.indigo.styleSystemControls !== false) throw new Error('profile shim failed: styleSystemControls should be false');

// Inputs. Named and system colours are read from DR's own table.
const colorTs = readFileSync(join(DR, 'src/utils/color.ts'), 'utf8');
const names = [...colorTs.matchAll(/^\s+'?([a-zA-Z-]+)'?: 0x[0-9a-f]{6},$/gm)].map((x) => x[1].toLowerCase());
const levels = [0, 36, 73, 109, 146, 182, 219, 255];
const grid = [];
for (const r of levels) for (const g of levels) for (const b of levels) grid.push(`rgb(${r}, ${g}, ${b})`);
const special = [
  '#abc', '#abcd', '#aabbcc', '#aabbccdd', '#ABC', 'transparent', 'currentcolor', '', 'notacolor',
  'hsl(210, 50%, 33%)', 'hsla(210, 50%, 33%, 0.5)', 'hsl(210deg 50% 33% / 50%)', 'hsl(0.5turn, 100%, 50%)', 'hsl(3.14159rad, 100%, 50%)',
  'rgb(100%, 50%, 0%)', 'rgb(10 20 30 / 0.5)', 'rgba(10, 20, 30, 0.125)', 'rgba(1, 2, 3, 0.005)', 'rgba(1, 2, 3, 0.995)', 'rgb(300, 0, 0)',
  'rgb(calc(255 / 2), 0, 0)', 'rgb(calc(10 + 20 * 2), 0, 0)', 'rgba(0, 0, 0, 0.13)',
  'color(srgb 1 0 0)', 'lab(50% 40 59)', 'oklch(0.7 0.1 200)', 'color-mix(in srgb, red, blue)', 'light-dark(#fff, #000)', 'rgb(from red r g b)', 'rgb(#ff0000)',
  'rgb(230, 55, 90)', 'rgb(0, 102, 204)', 'rgb(23, 23, 23)', 'rgb(51, 51, 51)', 'rgb(244, 244, 244)', 'rgb(26, 26, 26)', 'rgb(255, 204, 0)',
];
const DOM_FUNCS = ['color', 'color-mix', 'hwb', 'lab', 'lch', 'oklab', 'oklch'];
const isDom = (s) => {
  const c = s.trim().toLowerCase();
  return c.includes('(from ') || c.startsWith('rgb(#') || c.startsWith('rgba(#') || c.startsWith('light-dark(')
    || (c.endsWith(')') && DOM_FUNCS.some((f) => c.startsWith(`${f}(`) && c.lastIndexOf(f) === 0));
};
const inputs = [...grid, ...names, ...special];
const parse = inputs.map((input) => ({ input, out: isDom(input) ? 'skipped:dom' : (m.parseColorWithCache(input) || null) }));
const parsed = parse.filter((p) => p.out && p.out !== 'skipped:dom');

const hsl = parsed.slice(0, 600).map(({ out }) => { const h = m.rgbToHSL(out); return { rgb: out, hsl: h, back: m.hslToRGB(h) }; });
const strings = [
  ...parsed.slice(0, 200).map(({ out }) => out),
  { r: 1, g: 2, b: 3, a: 0.125 }, { r: 1, g: 2, b: 3, a: 0.005 }, { r: 1, g: 2, b: 3, a: 0.995 }, { r: 1, g: 2, b: 3, a: 0.5 },
  { r: 300, g: 0, b: 15, a: 1 }, { r: 0, g: 0, b: 0, a: 0 },
].map((rgb) => ({ rgb, rgbString: m.rgbToString(rgb), hexString: m.rgbToHexString(rgb) }));

const modify = [];
for (const [name, t] of Object.entries(themes)) {
  for (const { input, out } of parsed) {
    modify.push({ theme: name, input, bg: m.modifyBackgroundColor(out, t, false), fg: m.modifyForegroundColor(out, t, false), border: m.modifyBorderColor(out, t, false) });
  }
}
const matrix = Object.entries(themes).map(([name, t]) => ({ theme: name, svg: m.getSVGFilterMatrixValue(t), svgSepia10: m.getSVGFilterMatrixValue({ ...t, sepia: Math.min(100, t.sepia + 10) }) }));

// Declarations as WebKit's CSSOM hands them to DR (longhands, rgb() serialisation).
const DECLS = [
  ['background-color', 'rgb(255, 255, 255)'], ['background-color', 'rgba(0, 0, 0, 0)'], ['background-color', 'transparent'],
  ['background-color', 'inherit'], ['background-color', 'rgb(255, 255, 255)', { 'mask-image': 'url("m.svg")' }],
  ['color', 'rgb(51, 51, 51)'], ['color', 'initial'], ['color', 'currentcolor'], ['color', 'rgba(0, 0, 0, 0.5)'], ['color', 'white'],
  ['border-top-color', 'rgb(204, 204, 204)'], ['border-left-color', 'rgb(0, 0, 0)'], ['outline-color', 'rgb(0, 0, 255)'],
  ['border-top-color', 'initial', { 'border-top': '0px' }], ['border-top-color', 'initial', { 'border-top': 'none' }], ['border-top-color', 'initial', { 'border-top': '1px solid' }],
  ['background-image', 'none'],
  ['background-image', 'linear-gradient(rgb(255, 255, 255), rgb(0, 0, 0))'],
  ['background-image', 'linear-gradient(180deg, rgb(255, 255, 255) 0%, rgb(230, 240, 255) 100%)'],
  ['background-image', 'radial-gradient(circle, rgb(255, 238, 204), rgb(255, 255, 255))'],
  ['background-image', 'repeating-linear-gradient(45deg, rgb(0, 0, 0) 0px, rgb(255, 255, 255) 10px)'],
  ['background-image', '-webkit-linear-gradient(top, rgb(255, 255, 255), rgb(0, 0, 0))'],
  ['background-image', 'linear-gradient(rgb(255, 255, 255), rgb(0, 0, 0)), linear-gradient(rgb(0, 102, 204), transparent)'],
  ['box-shadow', 'rgba(0, 0, 0, 0.25) 0px 1px 2px 0px'],
  ['box-shadow', 'rgb(0, 0, 0) 0px 0px 0px 1px inset, rgb(255, 255, 255) 0px 1px 0px 0px'],
  ['text-shadow', 'rgb(255, 255, 255) 0px 1px 0px'], ['box-shadow', 'none'],
  ['scrollbar-color', 'rgb(1, 2, 3) rgb(4, 5, 6)'], ['scrollbar-color', 'auto'], ['color-scheme', 'light'],
  ['background-clip', 'padding-box'], ['background-size', 'cover'], ['background-position', 'initial'],
  ['fill', 'rgb(255, 0, 0)'], ['stroke', 'rgb(0, 0, 0)'], ['stop-color', 'rgb(255, 255, 255)'],
  ['-webkit-print-color-adjust', 'exact'], ['caret-color', 'rgb(0, 0, 0)'], ['text-decoration-color', 'rgb(255, 0, 0)'],
  ['column-rule-color', 'rgb(0, 0, 0)'], ['font-size', '14px'], ['background-color', 'notacolor'],
];
const fakeRule = (style = {}) => ({
  selectorText: '',
  parentStyleSheet: null,
  style: {
    getPropertyValue: (p) => style[p] || '',
    getPropertyPriority: () => '',
    get webkitMaskImage() { return style['-webkit-mask-image'] || ''; },
    get webkitMask() { return style['-webkit-mask'] || ''; },
    get mask() { return style.mask || ''; },
  },
});
const declarations = [];
for (const [name, t] of Object.entries(themes)) {
  m.clearColorPalette();
  for (const [property, value, ruleStyle] of DECLS) {
    const d = m.getModifiableCSSDeclaration(property, value, fakeRule(ruleStyle), m.variablesStore, [], null);
    const v = d && (typeof d.value === 'function' ? d.value(t) : d.value);
    declarations.push({ theme: name, property, value, ruleStyle: ruleStyle || {}, out: d ? { property: d.property, value: v, important: d.important } : null });
  }
}

// Static sheets: user-agent (isIFrame true), inline override, and the
// variables block exactly as inject/dynamic-theme/index.ts writes it.
const staticSheets = Object.entries(themes).map(([name, t]) => {
  m.clearColorPalette();
  const userAgent = m.getModifiedUserAgentStyle(t, true, t.styleSystemControls);
  const sel = t.selectionColor ? m.getSelectionColor(t) : null;
  const variables = [
    ':root {',
    `   --darkreader-neutral-background: ${m.modifyBackgroundColor(m.parseColorWithCache('#ffffff'), t)};`,
    `   --darkreader-neutral-text: ${m.modifyForegroundColor(m.parseColorWithCache('#000000'), t)};`,
    `   --darkreader-selection-background: ${sel?.backgroundColorSelection ?? 'initial'};`,
    `   --darkreader-selection-text: ${sel?.foregroundColorSelection ?? 'initial'};`,
    '}',
  ].join('\n');
  return { theme: name, userAgent, inline: m.getInlineOverrideStyle(), variables };
});

const json = JSON.stringify({
  meta: { version, commit: COMMIT, profile: 'webkit-iframe', ua: UA },
  themes, parse, hsl, strings, modify, matrix, declarations, static: staticSheets,
});
process.stdout.write(`===DR-VECTORS-BEGIN===\n${json}\n===DR-VECTORS-END===\n`);
