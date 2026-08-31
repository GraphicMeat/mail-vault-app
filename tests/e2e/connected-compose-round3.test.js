/**
 * E2E: Reporter round 3 — four compose fixes, asserted at the layer each one
 * actually broke in:
 *
 * 1. A new message opens from the account being READ — the mailbox on screen,
 *    or in All Inboxes the account of the last message opened. The identity
 *    that sent last (`settingsStore.lastComposeIdentity`) is an address, not an
 *    account: it is kept only when the account being read is the one that sent
 *    as it (it used to outrank the account outright, which wrote from the
 *    account you had just switched away from). The harness has no SMTP, so the
 *    write side (recorded after `smtp_ok`) can't fire here — these cases seed
 *    the store method directly and assert the READ side: the From row, and the
 *    staged `.eml` that a send with that default produces. Replies must ignore
 *    it; minimize→restore must keep the picked account (`_accountId` /
 *    `_fromAddress` round-trip through saved compose state).
 *
 * 2. Replying to your own message targets its recipients, not you — including
 *    when "you" is the account's Send Mail As alias, which is only knowable
 *    through the identity list. Reply All drops every own address and keeps
 *    everyone else. A note genuinely sent to yourself still replies to you.
 *
 * 3. A display name with a comma ("Doe, John") must survive the To line as ONE
 *    recipient. The proof is the staged MIME: with the old naive split,
 *    build_mime rejects the line and nothing ever reaches the Maildir stage,
 *    so `readStagedEml` succeeding with both addresses IS the fix. Trailing
 *    commas stay non-fatal.
 *
 * 4. "/" is the focus-search shortcut and used to fire while typing. Typing it
 *    in the body or a recipient field must keep focus where it is and never
 *    move it to the search input.
 */
import { waitForApp, waitForEmails } from './helpers.js';
import {
  EDITOR,
  setField,
  fieldValue,
  testidText,
  closeComposeHard,
  openComposeFresh,
  settingsCall,
  mailStoreSet,
  listSent,
  clickSend,
  readStagedEml,
  flatten,
  waitForOutboxError,
  modalOpen,
  clickButtonTitle,
  bubbles,
  clickBubble,
  editorText,
} from './composeHelpers.js';

const ALIAS = 'butcher@graphicmeat.com';
const COLLEAGUE = 'colleague@example.com';
const CC_OTHER = 'carol@example.com';

describe('Connected Compose Round 3', function () {
  this.timeout(180_000);

  let luke;
  let vader;

  before(async function () {
    await waitForApp();
    await waitForEmails();
    [luke, vader] = browser.mockAccounts || [];
    expect(luke?.id).toBeDefined();
    expect(vader?.id).toBeDefined();
  });

  afterEach(async function () {
    await closeComposeHard();
    await mailStoreSet({ selectedEmail: null, selectedEmailId: null, selectedThread: null });
    // Both are global, persisted settings state in a shared app instance: a
    // leaked override or remembered identity changes what every later compose
    // spec sees as "the default".
    for (const a of browser.mockAccounts || []) {
      await settingsCall('setSendAsAddress', a.id, '');
    }
    await browser.execute(() => {
      window.__SETTINGS_STORE__.setState({ lastComposeIdentity: null });
    });
  });

  const lastIdentity = () => browser.execute(() =>
    JSON.parse(JSON.stringify(window.__SETTINGS_STORE__.getState().lastComposeIdentity ?? null)));

  const headerLine = (raw, name) =>
    raw.split(/\r?\n/).find((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`)) || '';

  /** Focus an element, dispatch a "/" keydown at it, report where focus ended up. */
  const slashAt = (selector) => browser.execute((sel) => {
    const el = document.querySelector(sel);
    if (!el) return { ok: false, why: `no element for ${sel}` };
    el.focus();
    el.dispatchEvent(new KeyboardEvent('keydown', { key: '/', code: 'Slash', bubbles: true }));
    const active = document.activeElement;
    const placeholder = (active?.getAttribute?.('placeholder') || '').toLowerCase();
    return {
      ok: true,
      searchFocused: active?.tagName === 'INPUT' && placeholder.includes('search'),
      stillThere: active === el || el.contains(active),
    };
  }, selector);

  /** Seed `email` as the selection and open compose via 'r' | 'a' | 'f'. */
  async function openMode(email, key) {
    await closeComposeHard();
    const selection = { selectedEmail: email, selectedEmailId: email.uid, selectedThread: null };
    await mailStoreSet(selection);
    await browser.execute(() => document.activeElement?.blur());
    await mailStoreSet(selection);
    await browser.keys(key);
    await browser.waitUntil(modalOpen, {
      timeout: 15_000,
      interval: 200,
      timeoutMsg: `Compose did not open on "${key}"`,
    });
    await browser.pause(300);
  }

  const selfEmail = (overrides = {}) => ({
    uid: 373737,
    subject: 'Round three self',
    from: { address: luke.email, name: 'Me' },
    to: [{ address: COLLEAGUE }, { address: luke.email }],
    cc: [{ address: CC_OTHER }],
    replyTo: [],
    date: '2026-08-20T10:00:00.000Z',
    text: 'self-sent body',
    flags: ['\\Seen'],
    _accountId: luke.id,
    messageId: '<round3-self@example.com>',
    ...overrides,
  });

  // ── 1. last-used identity ────────────────────────────────────────────────

  it('defaults a new message to the account being read, not the one that sent last', async function () {
    await settingsCall('setLastComposeIdentity', vader.id, vader.email);
    await openComposeFresh();
    // luke's INBOX is what is on screen. A remembered identity belonging to
    // another account must not drag the account across with it.
    expect(await fieldValue('compose-from')).toBe(`${luke.id} ${luke.email}`);
  });

  it('lists a remembered alias in the From row and stages the send under it', async function () {
    // The alias is neither a login nor an override nor minable here — the row
    // must still show it, or the UI reads one identity while the wire gets
    // another. Remembered on luke because that is the account being read: an
    // address is remembered per account and survives on that account alone.
    await settingsCall('setLastComposeIdentity', luke.id, ALIAS);
    await openComposeFresh();
    expect(await fieldValue('compose-from')).toBe(`${luke.id} ${ALIAS}`);

    const subject = 'Round three remembered alias';
    const before = new Set(listSent(luke.id));
    await setField('compose-to', 'someone@example.com');
    await setField('compose-subject', subject);
    await setField('compose-delay', 0);
    expect(await clickSend()).toBe(true);
    await browser.pause(400);
    const formError = await testidText('compose-error');
    if (formError) throw new Error(`Send was rejected by the compose form: "${formError}"`);

    const raw = flatten(await readStagedEml(luke.id, before, subject));
    expect(headerLine(raw, 'From')).toContain(`<${ALIAS}>`);
    await waitForOutboxError(subject);
  });

  it('a reply ignores the remembered identity and stays on the receiving account', async function () {
    await settingsCall('setLastComposeIdentity', vader.id, vader.email);
    await openMode(selfEmail({
      from: { address: 'ann@example.com', name: 'Ann' },
      to: [{ address: luke.email }],
      cc: [],
    }), 'r');
    expect(await fieldValue('compose-from')).toBe(`${luke.id} ${luke.email}`);
    expect(await fieldValue('compose-to')).toBe('ann@example.com');
  });

  it('minimize and restore keep the picked From account', async function () {
    await openComposeFresh();
    if (!(await setField('compose-from', `${vader.id} ${vader.email}`))) {
      throw new Error('compose-from select is missing');
    }
    // Something typed, so the draft minimizes instead of closing empty.
    await setField('compose-subject', 'Round three minimize');
    expect(await clickButtonTitle('Minimize')).toBe(true);
    await browser.waitUntil(async () => (await bubbles()).length > 0, {
      timeout: 10_000, interval: 200, timeoutMsg: 'no minimized bubble appeared',
    });
    await clickBubble(0);
    await browser.waitUntil(modalOpen, {
      timeout: 10_000, interval: 200, timeoutMsg: 'compose did not restore from its bubble',
    });
    await browser.pause(300);
    expect(await fieldValue('compose-from')).toBe(`${vader.id} ${vader.email}`);
    expect(await fieldValue('compose-subject')).toBe('Round three minimize');
  });

  // ── 2. reply-to-self ─────────────────────────────────────────────────────

  it('reply to my own message targets its recipients, not me', async function () {
    await openMode(selfEmail(), 'r');
    expect(await fieldValue('compose-to')).toBe(COLLEAGUE);
    expect(await fieldValue('compose-cc')).toBe('');
  });

  it('detects my own Send Mail As alias as me', async function () {
    await settingsCall('setSendAsAddress', luke.id, ALIAS);
    await openMode(selfEmail({
      from: { address: ALIAS, name: 'Me As Alias' },
      messageId: '<round3-alias@example.com>',
    }), 'r');
    expect(await fieldValue('compose-to')).toBe(COLLEAGUE);
  });

  it('reply-all on my own message keeps everyone else and drops every own address', async function () {
    await openMode(selfEmail(), 'a');
    expect(await fieldValue('compose-to')).toBe(COLLEAGUE);
    expect(await fieldValue('compose-cc')).toBe(CC_OTHER);
  });

  it('a message from my OTHER account is also "me" when replying', async function () {
    // Sent from vader, the copy lives in luke's mailbox. "Me" spans every
    // account's identities, not just the account that holds the message.
    await openMode(selfEmail({
      from: { address: vader.email, name: 'My Other Account' },
      to: [{ address: COLLEAGUE }],
      cc: [],
      messageId: '<round3-cross-account@example.com>',
    }), 'r');
    expect(await fieldValue('compose-to')).toBe(COLLEAGUE);
    // The reply still composes from the account that holds the message.
    expect(await fieldValue('compose-from')).toBe(`${luke.id} ${luke.email}`);
  });

  it('a note genuinely sent to myself still replies to me', async function () {
    await openMode(selfEmail({
      to: [{ address: luke.email }],
      cc: [],
      messageId: '<round3-note@example.com>',
    }), 'r');
    expect(await fieldValue('compose-to')).toBe(luke.email);
  });

  // ── 3. commas on the To line ─────────────────────────────────────────────

  it('a quoted display name with a comma stages as one recipient', async function () {
    const subject = 'Round three quoted name';
    const before = new Set(listSent(luke.id));
    await openComposeFresh();
    await setField('compose-to', '"Doe, John" <doe@example.com>, second@example.com');
    await setField('compose-subject', subject);
    await setField('compose-delay', 0);
    expect(await clickSend()).toBe(true);
    await browser.pause(400);
    const formError = await testidText('compose-error');
    if (formError) throw new Error(`Send was rejected by the compose form: "${formError}"`);

    // With the naive comma split, build_mime rejects "Doe" as a recipient and
    // nothing is ever staged — this file existing is the fix working.
    const raw = flatten(await readStagedEml(luke.id, before, subject));
    const to = headerLine(raw, 'To');
    expect(to).toContain('doe@example.com');
    expect(to).toContain('second@example.com');
    // lettre writes a display name with specials as an RFC 2047 encoded-word,
    // not a quoted-string — either form must decode to the intact name.
    const encodedWord = `=?utf-8?b?${Buffer.from('Doe, John').toString('base64')}?=`;
    expect(to.includes('"Doe, John"') || to.includes(encodedWord)).toBe(true);
    // Two recipients on the wire, not three fragments.
    expect((to.match(/@example\.com/g) || []).length).toBe(2);
    await waitForOutboxError(subject);
  });

  it('a trailing comma on the To line is ignored, not fatal', async function () {
    const subject = 'Round three trailing comma';
    const before = new Set(listSent(luke.id));
    await openComposeFresh();
    await setField('compose-to', 'trail@example.com,');
    await setField('compose-subject', subject);
    await setField('compose-delay', 0);
    expect(await clickSend()).toBe(true);
    await browser.pause(400);
    expect(await testidText('compose-error')).toBeFalsy();

    const raw = flatten(await readStagedEml(luke.id, before, subject));
    expect(headerLine(raw, 'To')).toContain('trail@example.com');
    await waitForOutboxError(subject);
  });

  // ── 4. "/" while typing ──────────────────────────────────────────────────

  it('"/" typed in the compose body stays in the body', async function () {
    await openComposeFresh();
    const result = await slashAt(EDITOR);
    expect(result.ok).toBe(true);
    expect(result.searchFocused).toBe(false);
    expect(result.stillThere).toBe(true);

    // And the character itself lands: insert text the way WebKit types it.
    await browser.execute((sel) => {
      const el = document.querySelector(sel);
      el.focus();
      document.execCommand('insertText', false, 'drag/drop');
    }, EDITOR);
    expect(await editorText()).toContain('drag/drop');
  });

  it('"/" in a recipient field keeps focus there', async function () {
    await openComposeFresh();
    const result = await slashAt('[data-testid="compose-to"]');
    expect(result.ok).toBe(true);
    expect(result.searchFocused).toBe(false);
    expect(result.stillThere).toBe(true);
  });

  it('the remembered identity starts unset in a fresh profile', async function () {
    // The write side records after a successful SMTP send, which this harness
    // cannot produce — so prove the default and the failed-send behaviour:
    // a send that never reached smtp_ok must not move the identity.
    expect(await lastIdentity()).toBe(null);
    const subject = 'Round three no smtp no memory';
    await openComposeFresh();
    await setField('compose-to', 'someone@example.com');
    await setField('compose-subject', subject);
    await setField('compose-delay', 0);
    expect(await clickSend()).toBe(true);
    await waitForOutboxError(subject);
    expect(await lastIdentity()).toBe(null);
  });
});
