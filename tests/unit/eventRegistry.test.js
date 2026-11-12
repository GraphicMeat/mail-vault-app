/**
 * `src-daemon/events.json` is the one list of event names that cross a
 * process or window boundary: what the daemon emits (the shell forwards every
 * one to the webview), what the shell emits itself, what one webview window
 * emits to another, the browser demo's own, and the Tauri/plugin built-ins the
 * app listens for. These tests read the sources of all three sides and fail
 * when an emitter or a listener names an event the list does not hold, when a
 * listed event is no longer emitted, or when an emitted event has no listener
 * (unless the list says why under `unheard`). A typo then fails here instead
 * of compiling into a listener that never fires.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { posix } from 'node:path';
import { rustNonTestCode } from './helpers/rustSources.js';

// Forward slashes on every OS: the paths below are compared as strings.
const { join, dirname } = posix;

const read = (p) => readFileSync(p, 'utf8');
const walk = (d, ext, skip = []) => readdirSync(d).flatMap((f) => {
  const p = join(d, f);
  if (skip.some((s) => p.includes(s))) return [];
  return statSync(p).isDirectory() ? walk(p, ext, skip) : ext.some((e) => p.endsWith(e)) ? [p] : [];
});
const sources = (files) => files.map((file) => ({ file, src: read(file) }));
const sorted = (names) => [...new Set(names)].sort();

// ---------------------------------------------------------------- Rust side

/** Rust source without its test items and line comments. */
const rustCode = rustNonTestCode;

/** `const NAME: &str = "value"` of every file, keyed `file::NAME`. */
function rustConsts(files) {
  const out = new Map();
  for (const { file, src } of files) {
    for (const m of rustCode(src).matchAll(/const\s+([A-Z][A-Z0-9_]*)\s*:\s*&(?:'static\s+)?str\s*=\s*"([^"]+)"/g)) out.set(`${file}::${m[1]}`, m[2]);
  }
  return out;
}

/** The files a Rust module path names, seen from `file` (`crate::a::b`, `super::c`). */
function moduleFiles(file, root, path) {
  const parts = path.split('::');
  let dir;
  if (parts[0] === 'crate') {
    dir = root;
    parts.shift();
  } else {
    dir = /(?:^|\/)(?:mod|main|lib)\.rs$/.test(file) ? dirname(file) : file.replace(/\.rs$/, '');
    while (parts[0] === 'super' || parts[0] === 'self') if (parts.shift() === 'super') dir = dirname(dir);
  }
  const base = join(dir, ...parts);
  return [`${base}.rs`, `${base}/mod.rs`];
}

/** The value of const `ident` (bare, imported by `use`, or a module path) as seen from `file`. */
function resolveConst(consts, file, code, root, ident) {
  const parts = ident.split('::');
  const name = parts.pop();
  let candidates = [file];
  if (parts.length) candidates = moduleFiles(file, root, parts.join('::'));
  else {
    const use = code.match(new RegExp(String.raw`use\s+((?:crate|super|self)(?:::\w+)*)::(?:\{[^}]*\b${name}\b[^}]*\}|${name}\b)`));
    if (use) candidates = [file, ...moduleFiles(file, root, use[1])];
  }
  for (const c of candidates) if (consts.has(`${c}::${name}`)) return consts.get(`${c}::${name}`);
  return null;
}

/** Emit helpers whose event name is not their first argument: its index. */
const NAME_POSITION = { emit_to: 1, emit_if_current: 2 };
const NAME_ARG = /^\s*&?(?:"([^"]+)"|((?:(?:crate|super|self|[a-z_]+)::)*[A-Z][A-Z0-9_]*)\s*[,)])/;

/**
 * Event names Rust code emits: the name argument of `.emit(`, `emit_*(`, a
 * bare `emit(` closure, `(sinks.emit)(` and `event_line(`, when it is a string
 * literal or a `const &str`. A variable carrying a name on (a closure's own
 * parameter) is skipped: its callers pass the literal. `notNames` are literals
 * such a call takes that are not event names (a helper's state label).
 */
function rustEmits(roots, files, notNames = []) {
  const consts = rustConsts(files);
  const names = [];
  const unresolved = [];
  for (const { file, src } of files) {
    const root = roots.find((r) => file.startsWith(r));
    const code = rustCode(src);
    for (const m of code.matchAll(/(?:\b(emit\w*)|\bemit\s*\)|\bevent_line)\(/g)) {
      let rest = code.slice(m.index + m[0].length, m.index + m[0].length + 300);
      for (let skip = NAME_POSITION[m[1]] ?? 0; skip > 0; skip--) rest = rest.replace(/^\s*[^,()]*(?:\([^()]*\))?[^,()]*,/, '');
      const arg = NAME_ARG.exec(rest);
      if (!arg) continue;
      if (arg[1] !== undefined) {
        if (!notNames.includes(arg[1])) names.push(arg[1]);
        continue;
      }
      const v = resolveConst(consts, file, code, root, arg[2]);
      if (v === null) unresolved.push(`${file}: ${arg[2]}`);
      else names.push(v);
    }
  }
  return { names: sorted(names), unresolved };
}

/**
 * Names the shell's event pump compares an incoming event to: `name == "x"`,
 * `name == CONST`, `matches!(name, "a" | "b")`, and the `event:` field of a
 * declared table row (`native_lease::KINDS`).
 */
function rustNameMatches(root, constFiles, files) {
  const consts = rustConsts(constFiles);
  const names = [];
  const unresolved = [];
  for (const { file, src } of files) {
    const code = rustCode(src);
    for (const m of code.matchAll(/\bname\s*[!=]=\s*(?:"([^"]+)"|((?:(?:crate|super|self|[a-z_]+)::)*[A-Z][A-Z0-9_]*))/g)) {
      if (m[1] !== undefined) names.push(m[1]);
      else {
        const v = resolveConst(consts, file, code, root, m[2]);
        if (v === null) unresolved.push(`${file}: ${m[2]}`);
        else names.push(v);
      }
    }
    for (const m of code.matchAll(/matches!\(\s*name\s*,([^)]*)\)/g)) for (const l of m[1].matchAll(/"([^"]+)"/g)) names.push(l[1]);
    for (const m of code.matchAll(/\bevent:\s*(?:"([^"]+)"|((?:(?:crate|super|self|[a-z_]+)::)*[A-Z][A-Z0-9_]*))\s*,/g)) {
      if (m[1] !== undefined) names.push(m[1]);
      else {
        const v = resolveConst(consts, file, code, root, m[2]);
        if (v === null) unresolved.push(`${file}: ${m[2]}`);
        else names.push(v);
      }
    }
  }
  return { names: sorted(names), unresolved };
}

// ------------------------------------------------------------------ JS side

/** JS source without comments (crude: a `//` after `:` or a quote is a URL). */
const jsCode = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\w\\])\/\/.*$/gm, '$1');
/** A string literal; its value is `str(m, i)`, `i` the first of its three groups. */
const QUOTED = String.raw`(?:'([^'\n]*)'|"([^"\n]*)"|\x60([^\x60$\n]*)\x60)`;
const str = (m, i) => m[i] ?? m[i + 1] ?? m[i + 2];
const jsConsts = (code) => new Map([...code.matchAll(new RegExp(String.raw`\bconst\s+([A-Z][A-Z0-9_]*)\s*=\s*${QUOTED}`, 'g'))].map((m) => [m[1], str(m, 2)]));

/**
 * Event names JS code listens for. The literal forms: `listen('x'`,
 * `listenTo('x'`, `once('x'`, an `on('x'` wrapper, `bridge(listen, 'x'`,
 * `['a', 'b'].map(name => listen(name`, `for (const [name, …] of [['a', …]])
 * … listen(name`, and a same-file `const X = 'x'` passed by name. Any other
 * `listen(`/`listenTo(`/`once(` call forwards a name it was given and is
 * returned in `forwarded`, for the allowlist below.
 */
function jsListens(files) {
  const names = [];
  const forwarded = [];
  for (const { file, src } of files) {
    const code = jsCode(src);
    const consts = jsConsts(code);
    for (const m of code.matchAll(new RegExp(String.raw`(?<![\w$.])(?:on\(|bridge\(\s*\w+\s*,)\s*${QUOTED}`, 'g'))) names.push(str(m, 1));
    for (const m of code.matchAll(/\[([^[\]]*)\]\.map\(\s*\(?\s*(\w+)\s*\)?\s*=>\s*(?:\w+\.)?listen\(\s*\2\b/g)) {
      for (const l of m[1].matchAll(new RegExp(QUOTED, 'g'))) names.push(str(l, 1));
    }
    for (const m of code.matchAll(/for\s*\(\s*const\s*\[\s*(\w+)\s*,[^\]]*\]\s*of\s*\[([\s\S]*?)\]\s*\)\s*\{[\s\S]{0,300}?listen\(\s*\1\b/g)) {
      for (const l of m[2].matchAll(new RegExp(String.raw`\[\s*${QUOTED}\s*,`, 'g'))) names.push(str(l, 1));
    }
    for (const m of code.matchAll(/(?<![\w$])(listen|listenTo|once)\s*\(/g)) {
      if (/function\s+$/.test(code.slice(Math.max(0, m.index - 20), m.index))) continue;
      const rest = code.slice(m.index + m[0].length, m.index + m[0].length + 80);
      const lit = new RegExp(String.raw`^\s*${QUOTED}`).exec(rest);
      if (lit) {
        names.push(str(lit, 1));
        continue;
      }
      const id = /^\s*([A-Za-z_$][\w$]*)/.exec(rest)?.[1];
      if (id && consts.has(id)) names.push(consts.get(id));
      else forwarded.push(`${file}: ${m[1]}(${id ?? ''}`);
    }
  }
  return { names: sorted(names), forwarded: sorted(forwarded) };
}

/** Event names JS code emits: `emit('x'` and `emitTo(target, 'x'`, or a same-file const. */
function jsEmits(files) {
  const names = [];
  for (const { src } of files) {
    const code = jsCode(src);
    const consts = jsConsts(code);
    for (const m of code.matchAll(/(?<![\w$])(?:emit\(|emitTo\(\s*[^,()]+,)\s*([^,)]+)[,)]/g)) {
      const arg = m[1].trim();
      const lit = new RegExp(String.raw`^${QUOTED}$`).exec(arg);
      if (lit) names.push(str(lit, 1));
      else if (consts.has(arg)) names.push(consts.get(arg));
    }
  }
  return sorted(names);
}

// ------------------------------------------------------------------ the list

const LIST = JSON.parse(read('src-daemon/events.json'));
const DAEMON_ROOTS = ['src-daemon/src', 'src-core/src'];
const DAEMON_FILES = sources(DAEMON_ROOTS.flatMap((r) => walk(r, ['.rs'], ['/tests/'])));
const SHELL_FILES = sources(walk('src-tauri/src', ['.rs'], ['/tests/']));
// The pump, and the table of job holds it hands frames to.
const PUMP = SHELL_FILES.filter(({ file }) => ['src-tauri/src/daemon_channel.rs', 'src-tauri/src/native_lease.rs'].includes(file));
// src/mobile has its own list (src-mobile-engine/events.json) and seam test.
const WEB_FILES = sources(walk('src', ['.js', '.jsx'], ['__tests__', '.test.', '/mobile/', '/demo/']));
const DEMO_FILES = sources(walk('src/demo', ['.js', '.jsx'], ['__tests__']));

/** The restore helper's own `emit("running", …)` closure takes a state, not an event name. */
const NOT_EVENT_NAMES = ['running', 'cancelled', 'completed'];

/**
 * `listen(`/`listenTo(` calls that forward a name their caller chose; the
 * literal callers are scanned by the forms above. A new forwarding site goes
 * here, with its literal callers in a scanned form.
 */
const FORWARDING = [
  'src/components/settings/PendingActionsSettings.jsx: listen(name', // ['a', 'b'].map(name => listen(name
  'src/features/blitz/surfaces/docRegistry.js: listen(', // the registry's own listen(), not Tauri's
  'src/hooks/useEmailScheduler.js: listen(name', // for (const [name, handler] of [['notify', …]])
  'src/services/accountPolicy.js: listen(name',
  'src/services/backupScheduler.js: listen(name',
  'src/services/db/keychain.js: listen(name', // on('x', …)
  'src/services/insightsSession.js: listen(event', // tauriListen wrapper, called with a const
  'src/services/listenTo.js: listen(event', // listenTo('x', …)
  'src/stores/netActivityStore.js: listen(name', // on('x', …)
  'src/stores/safeStorage.js: listen(name', // on('x', …)
  'src/utils/notificationOpen.js: listen(event', // bridge(listen, 'x', …)
];

const daemon = rustEmits(DAEMON_ROOTS, DAEMON_FILES, NOT_EVENT_NAMES);
const shell = rustEmits(['src-tauri/src'], SHELL_FILES);
const pump = rustNameMatches('src-tauri/src', SHELL_FILES, PUMP);
const web = jsListens(WEB_FILES);

describe('src-daemon/events.json', () => {
  it('has the sections the tests read, each sorted without duplicates', () => {
    expect(Object.keys(LIST).sort()).toEqual(['builtin', 'daemon', 'demo', 'frontend', 'shell', 'unheard']);
    for (const key of ['builtin', 'daemon', 'demo', 'frontend', 'shell']) expect(LIST[key], key).toEqual(sorted(LIST[key]));
    // One name may come from the shell and a window both (`open-settings`: the menu, or a compose window).
    expect(LIST.daemon.filter((n) => LIST.shell.includes(n) || LIST.frontend.includes(n))).toEqual([]);
  });

  it('daemon: exactly the names the daemon emits', () => {
    expect(daemon.unresolved).toEqual([]);
    expect(daemon.names.length).toBeGreaterThan(40);
    expect(daemon.names).toEqual(LIST.daemon);
  });

  it('shell: exactly the names the shell emits itself', () => {
    expect(shell.unresolved).toEqual([]);
    expect(shell.names).toEqual(LIST.shell);
  });

  it('frontend: exactly the names one webview window emits to another', () => {
    expect(jsEmits(WEB_FILES)).toEqual(LIST.frontend);
  });

  it('demo: the browser demo emits only daemon names and its own', () => {
    const emitted = jsEmits(DEMO_FILES);
    expect(emitted.filter((n) => !LIST.daemon.includes(n) && !LIST.demo.includes(n))).toEqual([]);
    expect(LIST.demo.filter((n) => !emitted.includes(n))).toEqual([]);
  });

  it('every event the webview listens for is emitted by someone', () => {
    expect(web.names.length).toBeGreaterThan(50);
    const emitted = new Set([...LIST.daemon, ...LIST.shell, ...LIST.frontend, ...LIST.builtin]);
    expect(web.names.filter((n) => !emitted.has(n))).toEqual([]);
  });

  it('every listen call either names its event or is a known forwarding wrapper', () => {
    expect(web.forwarded).toEqual(sorted(FORWARDING.map((s) => s.replace(/\s*\/\/.*$/, ''))));
  });

  it("every name the shell's event pump matches is a daemon event", () => {
    expect(pump.unresolved).toEqual([]);
    expect(pump.names.length).toBeGreaterThan(5);
    expect(pump.names.filter((n) => !LIST.daemon.includes(n))).toEqual([]);
  });

  it('every emitted event has a listener, or the list says why not', () => {
    const heard = new Set([...web.names, ...pump.names]);
    const unheard = [...LIST.daemon, ...LIST.shell, ...LIST.frontend].filter((n) => !heard.has(n));
    expect(unheard).toEqual(Object.keys(LIST.unheard).sort());
    for (const [name, why] of Object.entries(LIST.unheard)) expect(why.length, name).toBeGreaterThan(10);
  });
});

describe('the scanners catch a mismatch', () => {
  it('a misspelt listener is seen and is not an emitted name', () => {
    const fx = [{ file: 'fx.js', src: "listen('bakup-progress', cb); listenTo('backup-progress', cb); on('setings-changed', cb);" }];
    const { names } = jsListens(fx);
    expect(names).toEqual(['backup-progress', 'bakup-progress', 'setings-changed']);
    expect(names.filter((n) => !LIST.daemon.includes(n))).toEqual(['bakup-progress', 'setings-changed']);
  });

  it('a listener that forwards an unknown name is reported', () => {
    const fx = [{ file: 'fx.js', src: 'const f = (n) => listen(n, cb);' }];
    expect(jsListens(fx).forwarded).toEqual(['fx.js: listen(n']);
  });

  it('a misspelt daemon emit, literal or const, is seen', () => {
    const fx = [
      { file: 'd/src/a.rs', src: 'const EVENT: &str = "folder-mov-progress";\nfn f(s: &S) { s.events.emit("custdy-status", v); s.events.emit(EVENT, v); }' },
      { file: 'd/src/b.rs', src: 'use crate::a::EVENT;\nfn g(b: &Bus) { b.emit(EVENT, v); emit_if_current(&s, &c, "notfy", p); }' },
    ];
    const r = rustEmits(['d/src'], fx);
    expect(r.unresolved).toEqual([]);
    expect(r.names).toEqual(['custdy-status', 'folder-mov-progress', 'notfy']);
  });

  it("a misspelt name in the shell's pump is seen", () => {
    const fx = [{ file: 'p/daemon_channel.rs', src: 'fn p(name: &str) { if name == "bulk-progres" {} matches!(name, "backup-access-neded" | "x"); }' }];
    expect(rustNameMatches('p', fx, fx).names).toEqual(['backup-access-neded', 'bulk-progres', 'x']);
  });

  it("a misspelt event in the pump's hold table, literal or const, is seen", () => {
    const fx = [
      { file: 'p/a.rs', src: 'pub(crate) const EVENT: &str = "abd-progres";' },
      { file: 'p/native_lease.rs', src: 'static KINDS: [Kind; 2] = [Kind { job: J, event: "cleanup-rn", id: f }, Kind { job: K, event: crate::a::EVENT, id: g }];' },
    ];
    const r = rustNameMatches('p', fx, fx);
    expect(r.unresolved).toEqual([]);
    expect(r.names).toEqual(['abd-progres', 'cleanup-rn']);
  });
});
