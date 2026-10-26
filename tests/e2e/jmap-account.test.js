/**
 * E2E (JMAP conf): add a JMAP account by its session URL, beside an IMAP one.
 *
 * The path a user on a JMAP server other than Fastmail takes: Other / Custom,
 * "Enter server settings manually", the JMAP protocol radio, the session URL
 * under Advanced (open, since nothing was discovered), a password. The modal
 * then tests the connection through the daemon (`imap_test_connection`
 * answered over JMAP) and saves the account.
 *
 * The mock serves http on loopback. An e2e build takes that URL
 * (providerKind.js `jmapSessionHost`, VITE_E2E only) and the debug daemon may
 * send the password there (MAILVAULT_JMAP_BASE, set by the shared conf).
 *
 * The folder list must come from the JMAP mailboxes: INBOX (the inbox role),
 * Work, and Work/Sub (a child mailbox). The mock is shared with jmap-mail, so
 * this spec reads only what that spec never changes: e3, and Work/Sub's e5.
 */
import { waitForApp, waitForEmails, openSettings, switchToFolder, visibleRowSubjects } from './helpers.js';
import { JMAP_EMAIL, JMAP_PASSWORD, SUBJECT, daemonLogHits, installNotImapProbe, notImapConsoleHits, openJmapFolder } from './mockJmap.js';

const SESSION_INPUT = 'input[aria-label="JMAP session URL"]';

/** `browser.waitUntil` whose failure names what never happened AND the last value seen. */
async function waitFor(probe, ok, what, timeout = 30_000, interval = 300) {
  let last = null;
  try {
    await browser.waitUntil(async () => { last = await probe(); return ok(last); }, { timeout, interval, timeoutMsg: what });
  } catch (err) {
    throw new Error(`${what}; last seen: ${JSON.stringify(last)} (${err.message})`);
  }
  return last;
}

/** Set a React-controlled input through the native setter, as typing would. */
const setInput = (selector, value) => browser.execute((sel, val) => {
  const input = document.querySelector(sel);
  if (!input) return false;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, String(val));
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}, selector, value);

/** Click the first visible button whose text contains `text` (inside `scope` when given). */
const clickButton = (text, scope = 'body') => browser.execute((needle, sel) => {
  for (const btn of document.querySelectorAll(`${sel} button`)) {
    if ((btn.textContent || '').includes(needle) && btn.offsetHeight > 0 && !btn.disabled) {
      btn.click();
      return true;
    }
  }
  return false;
}, text, scope);

/** Every folder row the sidebar draws, by path. */
const folderPaths = () => browser.execute(() =>
  [...document.querySelectorAll('[data-testid="folder-row"]')].map((r) => r.getAttribute('data-path')));

/** Open Work so Work/Sub is drawn. Ensure-open: the chevron is a toggle. */
async function expandWork() {
  await waitFor(folderPaths, (p) => p.includes('Work'), 'the sidebar never drew the JMAP folder "Work"', 60_000);
  if (!(await folderPaths()).includes('Work/Sub')) {
    await browser.execute(() => {
      const toggle = [...document.querySelectorAll('[data-testid="folder-toggle"]')]
        .find((b) => b.getAttribute('data-path') === 'Work');
      toggle?.click();
    });
  }
  await waitFor(folderPaths, (p) => p.includes('Work/Sub'), 'Work never showed its child folder Work/Sub', 20_000);
}

describe('Adding a JMAP account by its session URL', function () {
  this.timeout(240_000);

  before(async function () {
    await waitForApp();
    await waitForEmails();
    // Records any E_JMAP_NOT_IMAP the app logs; read by the final log case.
    await installNotImapProbe();
  });

  it('adds the account through the AccountModal, JMAP protocol, session URL and password', async function () {
    const sessionUrl = `${browser.mockJmap.origin}/jmap/session`;

    // With accounts present the sidebar has no Add button: it lives in
    // Settings > Accounts, which closes itself and opens the AccountModal.
    await openSettings();
    await browser.execute(() => {
      for (const tab of document.querySelectorAll('[data-testid="settings-page"] button, [data-testid="settings-page"] [role="tab"]')) {
        if ((tab.textContent || '').trim().toLowerCase() === 'accounts') { tab.click(); return; }
      }
    });
    await waitFor(
      () => browser.execute(() => {
        for (const btn of document.querySelectorAll('[data-testid="settings-page"] button')) {
          const text = (btn.textContent || '').trim();
          if (((text.includes('Add') && text.includes('Account')) || btn.getAttribute('title') === 'Add Account') && btn.offsetHeight > 0) {
            btn.click();
            return true;
          }
        }
        return false;
      }),
      (clicked) => clicked === true,
      'Settings > Accounts never offered Add Account',
    );

    await waitFor(() => clickButton('Other / Custom'), (c) => c === true, 'the provider list never offered Other / Custom');
    await waitFor(() => browser.execute(() => !!document.querySelector('input[name="email"]')), (x) => x, 'the account form never opened');

    expect(await setInput('input[name="email"]', JMAP_EMAIL)).toBe(true);
    expect(await setInput('input[name="password"]', JMAP_PASSWORD)).toBe(true);

    expect(await clickButton('Enter server settings manually', 'form')).toBe(true);
    await waitFor(
      () => browser.execute(() => {
        const radio = document.querySelector('[data-testid="account-protocol"] input[value="jmap"]');
        if (!radio) return false;
        if (!radio.checked) radio.click();
        return radio.checked;
      }),
      (checked) => checked === true,
      'the protocol row never offered JMAP',
    );

    // Advanced starts open when nothing was discovered: the URL input is there.
    await waitFor(() => browser.execute((sel) => !!document.querySelector(sel), SESSION_INPUT), (x) => x,
      'JMAP was picked but no session URL input appeared');
    expect(await setInput(SESSION_INPUT, sessionUrl)).toBe(true);
    // Picking JMAP hides the IMAP and SMTP inputs (they are required).
    expect(await browser.execute(() => !!document.querySelector('input[name="imapHost"]'))).toBe(false);

    const clicked = await browser.execute(() => {
      const btn = document.querySelector('form button[type="submit"]');
      if (!btn || btn.disabled) return false;
      btn.click();
      return true;
    });
    expect(clicked).toBe(true);

    // The connection test resolves either way. A failed add reports its reason
    // in the modal, and that reason is what a failing spec must say.
    const outcome = await waitFor(
      () => browser.execute((target) => {
        const text = document.body.innerText;
        if (text.includes('Account added successfully') || text.includes('Connected!')) return 'ok';
        const sidebar = document.querySelector('[data-testid="sidebar"]');
        if (sidebar && (sidebar.innerText || '').includes(target)) return 'ok';
        const err = document.querySelector('form [class*="mail-danger"]');
        if (err && err.innerText.trim()) return `error: ${err.innerText.trim()}`;
        return null;
      }, JMAP_EMAIL),
      (o) => o !== null,
      `the add neither succeeded nor reported an error for ${JMAP_EMAIL}`,
      60_000,
      500,
    );
    expect(outcome).toBe('ok');

    // What the modal saved is the JMAP shape: the session URL, Basic sign-in,
    // the session host as imapHost, and no IMAP or SMTP server of its own.
    const saved = await waitFor(
      () => browser.execute((target) => {
        const a = (window.__MAIL_STORE__.getState().accounts || []).find((x) => x.email === target);
        return a ? {
          jmapSessionUrl: a.jmapSessionUrl, jmapAuth: a.jmapAuth, imapHost: a.imapHost, smtpHost: a.smtpHost ?? null,
        } : null;
      }, JMAP_EMAIL),
      (a) => a !== null,
      `the store never listed ${JMAP_EMAIL}`,
    );
    expect(saved).toEqual({ jmapSessionUrl: sessionUrl, jmapAuth: 'basic', imapHost: '127.0.0.1', smtpHost: null });
  });

  it('updates JMAP metadata through a fresh native probe',async()=>{
    const result=await browser.executeAsync((email,done)=>{
      const state=window.__MAIL_STORE__.getState();const account=state.accounts.find(a=>a.email===email);
      state.updateAccount(account.id,{displayName:'S2.3 JMAP metadata'}).then(a=>done({name:a.displayName,secretFree:!['password','oauth2AccessToken','oauth2RefreshToken'].some(k=>Object.hasOwn(a,k))})).catch(e=>done({failed:String(e?.message||e)}));
    },JMAP_EMAIL);
    expect(result.failed).toBeUndefined();expect(result.name).toBe('S2.3 JMAP metadata');expect(result.secretFree).toBe(true);
  });

  it('lists the JMAP mailboxes as folders: INBOX, Work and Work/Sub', async function () {
    // The modal closes itself 1.5 s after success.
    await browser.waitUntil(async () => browser.execute(() => !document.querySelector('form input[name="email"]')),
      { timeout: 15_000, interval: 300, timeoutMsg: 'the AccountModal never closed after the add' });

    // The modal gave the account a fresh id: read it back by address.
    const accountId = await browser.execute((target) =>
      (window.__MAIL_STORE__.getState().accounts || []).find((a) => a.email === target)?.id || null, JMAP_EMAIL);
    expect(accountId).not.toBe(null);
    await openJmapFolder(accountId, 'INBOX');
    await waitFor(visibleRowSubjects, (rows) => rows.some((r) => r.includes(SUBJECT.e3)),
      `the JMAP INBOX never listed "${SUBJECT.e3}"`, 60_000, 500);

    await expandWork();
    const paths = await folderPaths();
    expect(paths).toEqual(expect.arrayContaining(['Work', 'Work/Sub']));

    // The child folder opens on its own mail.
    expect(await browser.execute(() => {
      const row = [...document.querySelectorAll('[data-testid="folder-row"]')].find((r) => r.getAttribute('data-path') === 'Work/Sub');
      if (!row) return false;
      row.click();
      return true;
    })).toBe(true);
    await waitFor(
      () => browser.execute(() => window.__MAIL_STORE__.getState().activeMailbox),
      (m) => m === 'Work/Sub',
      'clicking Work/Sub never opened it',
    );
    await waitFor(visibleRowSubjects, (rows) => rows.some((r) => r.includes(SUBJECT.sub)),
      `Work/Sub never listed "${SUBJECT.sub}"`, 60_000, 500);
  });

  it('keeps the IMAP account beside it', async function () {
    await switchToFolder('luke@mock.test', 'INBOX');
    expect((await visibleRowSubjects()).some((r) => r.includes('Luke message'))).toBe(true);
  });

  it('never sent the JMAP account down an IMAP path (daemon log)', async function () {
    // Anti-vacuity: this log is the daemon that spoke JMAP in this spec. It
    // warns once when it reads the loopback override (src-core jmap/base.rs).
    expect(daemonLogHits(browser.testDataDir, 'MAILVAULT_JMAP_BASE').length).toBeGreaterThan(0);
    const hits = daemonLogHits(browser.testDataDir, 'E_JMAP_NOT_IMAP');
    if (hits.length) console.log(`[jmap-account] E_JMAP_NOT_IMAP in daemon.log:\n${hits.join('\n')}`);
    expect(hits).toEqual([]);
    // And none reached the app's console. A probe that is gone would pass
    // an empty check, so it must be there.
    const consoleHits = await notImapConsoleHits();
    expect(Array.isArray(consoleHits)).toBe(true);
    expect(consoleHits).toEqual([]);
  });
});
