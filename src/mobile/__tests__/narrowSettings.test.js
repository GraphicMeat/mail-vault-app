// @vitest-environment node
// Desktop's settings views on a 375pt phone (src/mobile/Settings.jsx, `.mv-shared-ui`): long
// unbroken text (a host, an address) wraps or truncates instead of running past the screen, wide
// tables become one card per row, every control is styled and a finger's size, and none of it
// reaches desktop (no rule here applies outside `.mv-shared-ui`). Read from the stylesheets the
// phone builds (src/mobile/main.jsx: shared-ui.css, mobile.css) and the views' own markup.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** A sheet with its relative `@import`s inlined, as the bundle builds it. */
const readStyleSheet = (file) => {
  const path = file instanceof URL ? fileURLToPath(file) : file;
  return readFileSync(path, 'utf8').replace(/@import\s+'(\.{1,2}\/[^']+\.css)';/g, (_, rel) => readStyleSheet(resolve(dirname(path), rel)));
};

const phone = readStyleSheet(new URL('../shared-ui.css', import.meta.url)) + readFileSync(new URL('../mobile.css', import.meta.url), 'utf8');
const desktop = readStyleSheet(new URL('../../styles/index.css', import.meta.url));
const view = (name) => readFileSync(new URL(`../../components/settings/views/${name}`, import.meta.url), 'utf8');
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The declarations of the first rule whose selector list is exactly `selector`. */
const rule = (css, selector) => css.match(new RegExp(`(?:^|[\\n}])\\s*${esc(selector)}\\s*\\{([^}]*)\\}`))?.[1] ?? '';

describe('shared settings views at phone width', () => {
  it('Network Activity: the log is one card per connection, its host wrapping anywhere', () => {
    expect(rule(phone, '.mv-shared-ui .net-activity-table, .mv-shared-ui .net-activity-table tbody')).toMatch(/display: block/);
    expect(rule(phone, '.mv-shared-ui .net-activity-table tr')).toMatch(/flex-wrap: wrap/);
    expect(rule(phone, '.mv-shared-ui .net-activity-table td.net-activity-host')).toMatch(/overflow-wrap: anywhere/);
    expect(view('NetworkActivityView.jsx')).toMatch(/className="net-activity-table /);
    expect(view('NetworkActivityView.jsx')).toMatch(/net-activity-host/);
  });

  it('Network Activity: a failed connection keeps the danger colour', () => {
    expect(view('NetworkActivityView.jsx')).toMatch(/RESULT_KEYS\[e\.result\] \? '' : 'text-mail-danger'/);
  });

  it('Network Activity: a filter shrinks with the screen instead of pushing past it', () => {
    expect(rule(phone, '.mv-shared-ui .net-activity-filters > :is(select, label)')).toMatch(/min-width: 0;[^}]*max-width: 100%/);
  });

  it('Move to another computer: a long address truncates inside its row', () => {
    const src = view('TransferExportView.jsx');
    expect(src).toMatch(/<label key=\{a\.id\} className="[^"]*\bmin-w-0\b/);
    expect(src).toMatch(/<span className="truncate min-w-0">/);
    // A fieldset's own minimum is its widest row: it must be allowed to shrink too.
    expect(src).toMatch(/<fieldset className="min-w-0">/);
  });

  it('Fields: a field row wraps, and its fields and buttons are settings controls at 44px', () => {
    expect(rule(phone, '.mv-shared-ui .fields-row')).toMatch(/flex-wrap: wrap/);
    expect(phone).toMatch(/\.mv-shared-ui :is\(\.field-option > input:not\(\[type="color"\]\)[^{]*\{[^}]*min-height: 44px;[^}]*background: var\(--mail-input-bg\)/);
  });

  it('Unsubscribe and Deleted emails: each row wraps under its first cell on the phone only', () => {
    for (const table of ['unsubscribe-table', 'deleted-table']) {
      expect(rule(phone, `.mv-shared-ui .${table} tr`)).toMatch(/flex-wrap: wrap/);
      expect(desktop).not.toMatch(new RegExp(`(^|[\\n}])\\s*\\.${table} tr\\s*\\{`));
    }
  });

  it('touch sizes apply to the phone only, and never lower the 48px tab row', () => {
    const coarse = phone.slice(phone.indexOf('@media (pointer: coarse)'));
    expect(coarse).toMatch(/\.mv-shared-ui :is\(button, select/);
    expect(desktop.match(/@media \(pointer: coarse\) \{([\s\S]*?)\n\}/g)?.join('\n') ?? '').not.toMatch(/(^|[\s,{])\.settings-(nav-item|tabs)/);
    expect(coarse).toMatch(/:not\(\.settings-tabs > button\)/);
    expect(coarse).toMatch(/\.toggle-switch::before/);
  });

  it('the text field, the chat sample and TomSelect are styled on the phone as on desktop', () => {
    expect(rule(phone, '.settings-input')).toMatch(/background-color: var\(--mail-input-bg\)/);
    expect(rule(phone, '.sample-chat')).toMatch(/background: var\(--mail-bg\)/);
    expect(phone).toMatch(/:is\(\.settings-window, \.mv-shared-ui\) \.ts-wrapper\.single \.ts-control/);
  });

  it('the settings search shows one clear button', () => {
    expect(rule(phone, '.settings-search input::-webkit-search-cancel-button')).toMatch(/appearance: none/);
  });

  it('a chip in a list row gives way instead of being cut', () => {
    expect(rule(phone, '.mv-row .local-mail-label:last-child')).toMatch(/min-width: 0/);
    expect(readFileSync(new URL('../../styles/labels-fields.css', import.meta.url), 'utf8')).toMatch(/\.local-mail-label > span \{[^}]*text-overflow: ellipsis/);
  });
});
