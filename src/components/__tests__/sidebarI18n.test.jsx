// @vitest-environment jsdom

/**
 * The slice test does not mount Sidebar — it has a wide store surface and this
 * is asserting the catalog, not the render. It proves every string the
 * extraction was supposed to lift now exists as a key, and that the file itself
 * is drained.
 *
 * The key list below is a starting point, NOT the authority. It was seeded by a
 * `>[A-Z]…{3,}<` grep that missed `down` (lowercase) and then `up` (two chars).
 * The two sweep assertions are what actually prove the file is finished.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import en from '../../i18n/locales/en.json';

// Resolved from cwd, not `import.meta.url`: vitest.config forces jsdom for
// everything under src/components/**, and in jsdom `import.meta.url` is not a
// file: URL, so readFileSync rejects it.
const SRC = readFileSync(resolve(process.cwd(), 'src/components/Sidebar.jsx'), 'utf8');

const EXPECTED = [
  'sidebar.passwordMissing', 'sidebar.retry', 'sidebar.noInternet',
  'sidebar.microsoftIssue', 'sidebar.oauth2Expired', 'sidebar.timedOut',
  'sidebar.serverError', 'sidebar.viewErrorDetails', 'sidebar.retryConnection',
  'sidebar.repointAccount', 'sidebar.lastNDays', 'sidebar.loading',
  'sidebar.errorDetails', 'sidebar.errorDetailsLabel', 'sidebar.close',
  'sidebar.expandSidebar', 'sidebar.compose', 'sidebar.allInboxes',
  'sidebar.addAccount', 'sidebar.refreshEmails', 'sidebar.settings',
  'sidebar.reportABug', 'sidebar.referAFriend', 'sidebar.mail', 'sidebar.vault',
  'sidebar.collapseSidebar', 'sidebar.showingCachedData', 'sidebar.dragToResize',
  'sidebar.down', 'sidebar.up',
  // Found only by the sweep: these are multi-line JSX text nodes, where the
  // `>` and the text sit on different lines. No line-based grep can see them.
  'sidebar.allAccounts', 'sidebar.reenterPassword', 'sidebar.switchedProviders',
  'sidebar.changeServer', 'sidebar.learnMoreFaq', 'sidebar.viewMode', 'sidebar.folders',
];

describe('Sidebar extraction', () => {
  it('has every expected key in en.json', () => {
    expect(EXPECTED.filter(k => !(k in en))).toEqual([]);
  });

  it('uses every key it defined — no orphans left behind', () => {
    expect(EXPECTED.filter(k => !SRC.includes(k))).toEqual([]);
  });

  it('leaves no hardcoded English in a title, aria-label or placeholder', () => {
    expect(SRC.match(/(?:title|aria-label|placeholder)="[A-Za-z][^"]{2,}"/g) || []).toEqual([]);
  });

  // Down to one character: `up` is two, and a `{2,}` floor is precisely what
  // hid it on the first pass.
  it('leaves no hardcoded English text node, any case, any length', () => {
    expect(SRC.match(/>\s*[A-Za-z][A-Za-z0-9 ,.'!?:%-]*\s*</g) || []).toEqual([]);
  });
});
