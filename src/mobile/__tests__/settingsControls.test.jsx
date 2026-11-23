// @vitest-environment jsdom
// Every control on every phone settings page acts: each page is mounted fresh (Settings.jsx over
// the fake engine, fixtures/mockEngine.js) once per control, the control is used the way a finger
// would (a tap, another option, a typed value), and something must follow: an engine or shell call,
// a store change (the preferences through setPrefs, a sheet opening), a link handed to the system
// browser, a clipboard write, or the page showing something new (the control's own new value, a
// form, another page). Nothing may throw or log an error. Tapping the choice already chosen (a
// pressed, checked or current control) may rightly do nothing; NOOP lists any other control that
// rightly shows nothing new, each with why. A reorder handle is moved with the arrow keys.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import { installMockEngine } from './fixtures/mockEngine.js';
import { phonePages, openPage, settle } from './fixtures/settingsPages.js';

let t;
let Settings;
let useMobileStore;
let PREF_DEFAULTS;
let accounts;
let baseline;
let loadMobileLocale;
// The phone's label cache (loaded once per run, tags.js ensureTags): as the page first had it,
// so a label deleted by one control is back for the next.
let useTagStore;

const NOOP = {
};

/** The engine, reinstalled for every control so one control's write never shifts the next page. */
let calls = [];
/** Every engine or shell call the fake engine had no answer for, across all reinstalls. */
const unhandled = new Set();
function freshEngine() {
  for (const method of window.__MV_MOCK?.unhandled || []) unhandled.add(method);
  installMockEngine();
  globalThis.localStorage?.clear();
  const invoke = window.__TAURI__.core.invoke;
  calls = [];
  window.__TAURI__.core.invoke = (cmd, args) => {
    calls.push(cmd === 'daemon_rpc' ? args.method : `cmd:${cmd}`);
    return invoke(cmd, args);
  };
}

beforeAll(async () => {
  freshEngine();
  ({ t } = await import('../i18n.js'));
  ({ default: Settings } = await import('../Settings.jsx'));
  ({ useMobileStore } = await import('../store.js'));
  ({ PREF_DEFAULTS } = await import('../prefs.js'));
  accounts = (await window.__TAURI__.core.invoke('daemon_rpc', { method: 'mobile.accounts.list' })).accounts;
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
  ({ loadMobileLocale } = await import('../i18n.js'));
  ({ useTagStore } = await import('../tags.js'));
});

let errors;
beforeEach(() => {
  useMobileStore.setState({
    prefs: { ...PREF_DEFAULTS, aiEnabled: true, aiEndpointUrl: 'https://ai.example.test/v1', markAsReadMode: 'delay', badgeEnabled: true },
    accounts, activeAccountId: 'a1', activeFolder: 'INBOX', syncState: {}, reauthState: null,
    premium: { premium: true, source: 'apple', expiresMs: Date.now() + 86_400_000 },
  });
  baseline = useMobileStore.getState();
  errors = [];
  // A link leaves through a plain anchor (openExternal), a copy through the clipboard: both count.
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click() { calls.push(`open:${this.href}`); });
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { calls.push('clipboard'); } } });
  vi.spyOn(console, 'error').mockImplementation((...args) => {
    const text = args.map(String).join(' ');
    // React's reminder about a state update after the test's act ended is the harness's, not the page's.
    if (!/not wrapped in act/.test(text)) errors.push(text.slice(0, 200));
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const CONTROLS = 'button, input, select, textarea, [role="switch"]:not(button), [role="radio"]:not(button):not(input)';
/** The page's controls a person can use: enabled, not a tab, not inside a sample picture. */
const controlsOf = (root) => [...root.querySelector('.mv-settings__body').querySelectorAll(CONTROLS)]
  .filter((el) => !el.disabled && el.type !== 'hidden' && !el.closest('[role="tablist"], figure, [aria-hidden="true"], fieldset:disabled'));
const nameOf = (el) => (el.getAttribute('aria-label') || el.getAttribute('data-testid') || (el.labels?.[0]?.textContent) || el.textContent || el.getAttribute('placeholder') || el.name || el.type || '').trim().replace(/\s+/g, ' ').slice(0, 48);
const storeJson = () => JSON.stringify(useMobileStore.getState(), (k, v) => (typeof v === 'function' ? undefined : v));

/** Uses one control as a finger would. Returns what it set (for a field: the typed value). */
async function use(el) {
  const tag = el.tagName.toLowerCase();
  if (tag === 'select') {
    const other = [...el.options].find((o) => !o.disabled && o.value !== el.value);
    if (!other) return 'only-option';
    await act(async () => { fireEvent.change(el, { target: { value: other.value } }); });
    return other.value;
  }
  if (tag === 'textarea' || (tag === 'input' && !['checkbox', 'radio', 'button', 'submit', 'range', 'file', 'color'].includes(el.type))) {
    const value = { number: '7', time: '07:30', date: '2026-01-02', url: 'https://x.example.test', email: 'x@example.test', search: 'theme' }[el.type] || 'Sample text';
    await act(async () => { fireEvent.focus(el); fireEvent.change(el, { target: { value } }); });
    await act(async () => { fireEvent.blur(el); });
    return value;
  }
  if (tag === 'input' && el.type === 'range') {
    const value = String(el.max && el.max !== el.value ? el.max : el.min);
    await act(async () => { fireEvent.change(el, { target: { value } }); });
    return value;
  }
  if (tag === 'input' && el.type === 'color') {
    await act(async () => { fireEvent.change(el, { target: { value: '#123456' } }); fireEvent.blur(el); });
    return '#123456';
  }
  if (el.classList.contains('account-settings-drag-handle')) {
    const last = !el.closest('li')?.nextElementSibling;
    await act(async () => { fireEvent.keyDown(el, { key: last ? 'ArrowUp' : 'ArrowDown' }); });
    return null;
  }
  await act(async () => { fireEvent.click(el); });
  return null;
}
/** The choice already made: tapping it again rightly changes nothing. */
const chosen = (el) => el.matches('[aria-pressed="true"], [aria-checked="true"], [aria-selected="true"], [aria-current]:not([aria-current="false"])')
  || (el.type === 'radio' && el.checked);

describe('every settings control acts', () => {
  const table = [];
  for (const page of phonePages()) {
    it(`${page.name}`, async () => {
      freshEngine();
      // A language picked on an earlier page stays picked: every page starts in English.
      await loadMobileLocale(['en'], 'en');
      let view = await openPage(render, Settings, t, page);
      const tagBaseline = useTagStore.getState();
      const count = controlsOf(view.container).length;
      const noop = [];
      const threw = [];
      let again = 0;
      for (let i = 0; i < count; i++) {
        if (i) {
          cleanup();
          freshEngine();
          await loadMobileLocale(['en'], 'en');
          useMobileStore.setState(baseline, true);
          useTagStore.setState(tagBaseline, true);
          view = await openPage(render, Settings, t, page);
        }
        const el = controlsOf(view.container)[i];
        if (!el) { noop.push(`#${i} gone on a fresh page`); continue; }
        const name = nameOf(el);
        const wasChosen = chosen(el);
        const before = { calls: calls.length, store: storeJson(), html: view.container.innerHTML, errors: errors.length,
          alerts: view.container.querySelectorAll('[role="alert"]').length };
        let set;
        try {
          set = await use(el);
          await settle();
        } catch (error) {
          threw.push(`${name}: ${error.message}`);
          continue;
        }
        if (errors.length > before.errors) threw.push(`${name}: ${errors.slice(before.errors).join(' | ')}`);
        // A control that fails says so in an alert: a failure, not an action (unless the fake
        // engine had no answer for what it asked, checked against the engine below).
        const alerts = [...view.container.querySelectorAll('[role="alert"]')];
        const unanswered = [...(window.__MV_MOCK?.unhandled || [])].length > 0;
        if (alerts.length > before.alerts && !unanswered) threw.push(`${name}: alert ${alerts.map((a) => a.textContent.trim().slice(0, 80)).join(' | ')}`);
        const shows = set !== null && set !== 'only-option' && el.isConnected && el.value === set;
        const acted = calls.length > before.calls || storeJson() !== before.store || view.container.innerHTML !== before.html || shows;
        if (!acted && wasChosen) again++;
        else if (!acted && !(NOOP[page.name] || []).includes(name)) noop.push(name);
      }
      table.push({ page: page.name, controls: count, chosenAgain: again, noop: noop.length, threw: threw.length });
      expect({ noop, threw }).toEqual({ noop: [], threw: [] });
    }, 240_000);
  }

  it('every call the fake engine could not answer is one the engine or the shell has', () => {
    for (const method of window.__MV_MOCK?.unhandled || []) unhandled.add(method);
    const known = (name) => execFileSync('git', ['grep', '-l', '-F', name.startsWith('cmd:') ? `fn ${name.slice(4)}(` : `"${name}"`,
      '--', 'src-mobile-engine', 'src-tauri-mobile'], { encoding: 'utf8' }).trim() !== '';
    const unknown = [...unhandled].filter((name) => { try { return !known(name); } catch { return true; } });
    expect(unknown).toEqual([]);
  });

  it('summary', () => {
    // The audit table, for the report.
    console.log(JSON.stringify({ pages: table.length, controls: table.reduce((n, r) => n + r.controls, 0), table }));
    expect(table.length).toBeGreaterThan(20);
  });
});
