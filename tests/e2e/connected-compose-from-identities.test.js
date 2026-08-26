/**
 * E2E: From identities — one account, several addresses it may send from.
 *
 * The Fastmail reporter who asked for the send-as override came back for the
 * rest of it: the override is a per-account *default*, and a mailbox with
 * aliases needs to pick per message. The From row now lists every address an
 * account can send from — its override, its login, and any address mined from
 * its own Sent cache — grouped under the account.
 *
 * What is worth asserting here is the WIRE, not the label: the existing
 * send-as spec proves the selected option's text, which a From row could get
 * right while still handing SMTP the login address. So the three send cases
 * below read the `.eml` compose stages on disk. The harness has NO SMTP server
 * (mockImap points smtpHost at the mock IMAP port), so a real Send builds the
 * MIME, stages the file under `Maildir/<accountId>/Sent/cur/`, and only then
 * fails on SMTP — that file is what left the compose window.
 *
 * The Fastmail label swap ("Login Address", not "Email Address") is the other
 * half of the same report and is asserted at both surfaces: the add-account
 * form, where the provider tile decides it, and Settings → Accounts, where the
 * stored account record does.
 *
 * Not covered: sending from a *mined* address specifically. Once an address is
 * in the list it is the same code path as the override — connected-send-as-alias
 * already proves mined addresses reach the selector.
 */
import {
  waitForApp,
  waitForEmails,
  openSettings,
  closeSettings,
  clickSettingsNav,
} from './helpers.js';
import {
  setField,
  fieldValue,
  testidText,
  closeComposeHard,
  openComposeFresh,
  settingsCall,
  listSent,
  clickSend,
  readStagedEml,
  flatten,
  waitForOutboxError,
} from './composeHelpers.js';

const ALIAS = 'butcher@graphicmeat.com';

describe('Connected Compose From Identities', function () {
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
    // The override is global settings state: a case that sets one has to put it
    // back, or every later spec in this single-app run composes as the alias.
    for (const a of browser.mockAccounts || []) {
      await settingsCall('setSendAsAddress', a.id, '');
    }
    // Same for the remembered identity — there is no setter that clears it.
    await browser.execute(() => window.__SETTINGS_STORE__.setState({ lastComposeIdentity: null }));
  });

  /** The From `<select>` as rendered: optgroups keep their children, bare options don't. */
  const fromTree = () => browser.execute(() => {
    const el = document.querySelector('[data-testid="compose-from"]');
    if (!el) return null;
    return {
      value: el.value,
      selectedText: el.options[el.selectedIndex]?.text?.trim() ?? null,
      children: [...el.children].map((c) => c.tagName === 'OPTGROUP'
        ? { group: c.label, options: [...c.children].map((o) => ({ value: o.value, text: o.text.trim() })) }
        : { option: { value: c.value, text: c.text.trim() } }),
    };
  });

  const headerLine = (raw, name) =>
    raw.split(/\r?\n/).find((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`)) || '';

  /**
   * Send one message and hand back the staged MIME.
   *
   * `from` is the From-row key to pick, or null to leave the row alone and let
   * the account's own default stand — the distinction IS the feature, so it is
   * a parameter rather than a fixed step.
   */
  async function sendAndStage({ account, from = null, subject }) {
    const before = new Set(listSent(account.id));
    await openComposeFresh();

    if (from) {
      if (!(await setField('compose-from', from))) {
        throw new Error('compose-from select is missing — nothing to pick an identity from');
      }
      const settled = await fieldValue('compose-from');
      if (settled !== from) {
        throw new Error(
          `compose-from did not settle on "${from}"; it reads "${settled}" — the ` +
          `option for that identity was never rendered`,
        );
      }
    }

    await setField('compose-to', 'someone@example.com');
    await setField('compose-subject', subject);
    await setField('compose-delay', 0);

    expect(await clickSend()).toBe(true);
    await browser.pause(400);

    // The form validates before it ever builds a MIME, and a rejected submit
    // looks exactly like a staging failure from the disk side.
    const formError = await testidText('compose-error');
    if (formError) throw new Error(`Send was rejected by the compose form: "${formError}"`);

    const raw = flatten(await readStagedEml(account.id, before, subject));
    await waitForOutboxError(subject);
    return raw;
  }

  // ── the list ─────────────────────────────────────────────────────────────

  it('groups an account\'s addresses under it and leaves a one-address account flat', async function () {
    await settingsCall('setSendAsAddress', luke.id, ALIAS);
    await openComposeFresh();

    const tree = await fromTree();
    expect(tree).not.toBe(null);

    // The account with two addresses is an <optgroup> — that native grouping is
    // the indent the report asked for, and a flat list of five addresses with
    // no owner is exactly what it asked to be rid of.
    const group = tree.children.find((c) => c.group);
    expect(group).toBeDefined();
    expect(group.group).toBe(luke.name);
    expect(group.options.map((o) => o.text)).toEqual([ALIAS, luke.email]);
    expect(group.options.map((o) => o.value))
      .toEqual([`${luke.id} ${ALIAS}`, `${luke.id} ${luke.email}`]);

    // Every other account has only its login, so it stays a bare option — an
    // optgroup of one would indent an account under itself.
    const flat = tree.children.filter((c) => c.option);
    expect(flat.length).toBe((browser.mockAccounts || []).length - 1);
    expect(flat.map((c) => c.option.text)).toContain(vader.email);
    expect(flat.every((c) => !c.option.value.startsWith(`${luke.id} `))).toBe(true);

    // A new message starts on the account's default, which is the override.
    expect(tree.value).toBe(`${luke.id} ${ALIAS}`);
    expect(tree.selectedText).toBe(ALIAS);
  });

  // ── the wire ─────────────────────────────────────────────────────────────

  it('sends from the account default when the From row is left alone', async function () {
    await settingsCall('setSendAsAddress', luke.id, ALIAS);

    const subject = 'Identity default';
    const raw = await sendAndStage({ account: luke, subject });

    expect(headerLine(raw, 'From')).toContain(`<${ALIAS}>`);
    // The whole point of the override is that the login never reaches the
    // recipient — not in From, not anywhere else in the header block.
    expect(raw.slice(0, raw.indexOf('\r\n\r\n') + 1).toLowerCase()).not.toContain(luke.email);
  });

  it('sends from the login address when it is picked out from under the alias', async function () {
    await settingsCall('setSendAsAddress', luke.id, ALIAS);

    const subject = 'Identity picked login';
    const raw = await sendAndStage({
      account: luke,
      from: `${luke.id} ${luke.email}`,
      subject,
    });

    // Picking the login has to CLEAR the override for this message, not merely
    // relabel the row: `sendAsEmail` is derived from the pick, so a From row
    // that reads "login" while SMTP is handed the alias is the failure this
    // case exists for.
    expect(headerLine(raw, 'From')).toContain(`<${luke.email}>`);
    expect(raw.toLowerCase()).not.toContain(ALIAS.toLowerCase());
    // Message-ID follows the From domain, so it moves back with it.
    expect(headerLine(raw, 'Message-ID')).toContain(`@${luke.email.split('@')[1]}>`);
  });

  it('sends under the account whose address was picked, not the one compose opened on', async function () {
    // Compose opens on the active account (luke). Picking vader's address has
    // to move the whole send — credentials, Sent folder, From — or the message
    // is filed under one account and sent as another.
    const subject = 'Identity other account';
    const lukeSentBefore = listSent(luke.id).length;
    const raw = await sendAndStage({
      account: vader,
      from: `${vader.id} ${vader.email}`,
      subject,
    });

    expect(headerLine(raw, 'From')).toContain(`<${vader.email}>`);
    // readStagedEml only ever looked in vader's Maildir, so the file being there
    // is half the proof; luke's Sent staying untouched is the other half.
    expect(listSent(luke.id).length).toBe(lukeSentBefore);
  });

  // ── the account being read ───────────────────────────────────────────────
  //
  // A fresh compose used to open on the identity that last SENT, so composing
  // right after switching account wrote from the account just left behind. The
  // mailbox on screen decides now; the remembered identity is an address, and
  // only survives on the account that sent as it.

  it('opens on the account being read, not the one that sent last', async function () {
    await settingsCall('setLastComposeIdentity', vader.id, vader.email);

    await openComposeFresh();

    // luke is the active account for this run — vader sent last.
    expect(await fieldValue('compose-from')).toBe(`${luke.id} ${luke.email}`);
  });

  it('keeps the remembered address within the account being read', async function () {
    // The alias is luke's account default; the login is what he last sent as.
    await settingsCall('setSendAsAddress', luke.id, ALIAS);
    await settingsCall('setLastComposeIdentity', luke.id, luke.email);

    await openComposeFresh();

    expect(await fieldValue('compose-from')).toBe(`${luke.id} ${luke.email}`);
  });

  it('opens on the account of the message being read in the unified inbox', async function () {
    const yoda = (browser.mockAccounts || [])[2];
    expect(yoda?.id).toBeDefined();
    // In All Inboxes every account's mail is on screen at once and the active
    // account is only whichever one was last opened — so it must not decide.
    await settingsCall('setLastComposeIdentity', luke.id, luke.email);

    // yoda's UIDs start at 901, which dates its mail newest in the suite, so its
    // rows sort to the top of the unified list without scrolling a virtualized
    // 700-row list (see MOCK_ACCOUNTS in wdio.conf.js). 906 is picked over the
    // top three: 907/908/909 carry the body-fetch faults.
    const SUBJECT = 'Yoda message 906';
    const activate = (id) => browser.execute((accountId) => {
      window.__MAIL_STORE__.getState().activateAccount(accountId, 'INBOX');
    }, id);

    try {
      // The unified list is built from each account's header cache, so yoda's
      // mail can only reach it once yoda has been opened in this run. Solo, this
      // spec never opens it and the unified list is luke's mail alone — which
      // the active account would get right for the wrong reason.
      await activate(yoda.id);
      await browser.waitUntil(
        async () => browser.execute((needle) => (window.__MAIL_STORE__.getState().emails || [])
          .some((e) => (e.subject || '').includes(needle)), SUBJECT),
        { timeout: 60_000, interval: 500, timeoutMsg: `yoda's INBOX never loaded "${SUBJECT}"` },
      );
      await activate(luke.id);
      await browser.waitUntil(
        async () => (await browser.execute(() => {
          const s = window.__MAIL_STORE__.getState();
          return s.activeAccountId;
        })) === luke.id,
        { timeout: 60_000, interval: 500, timeoutMsg: 'never came back to luke' },
      );

      expect(await browser.execute(() => {
        const btn = document.querySelector('[data-testid="all-inboxes-btn"]');
        if (!btn || btn.offsetHeight === 0) return false;
        btn.click();
        return true;
      })).toBe(true);

      await browser.waitUntil(
        async () => browser.execute((needle) => [...document.querySelectorAll('[data-testid="email-row"]')]
          .some((r) => (r.textContent || '').includes(needle)), SUBJECT),
        {
          timeout: 60_000,
          interval: 300,
          timeoutMsg: `"${SUBJECT}" never rendered in the unified inbox`,
        },
      );
      expect(await browser.execute((needle) => {
        const row = [...document.querySelectorAll('[data-testid="email-row"]')]
          .find((r) => (r.textContent || '').includes(needle));
        if (!row) return false;
        row.click();
        return true;
      }, SUBJECT)).toBe(true);

      // The click resolves the row's real account — assert that landed before
      // reading the From row, or a failure here can't name which half broke.
      await browser.waitUntil(
        async () => (await browser.execute(() => window.__MAIL_STORE__.getState().lastSelectedAccountId)) === yoda.id,
        { timeout: 20_000, interval: 200, timeoutMsg: 'clicking a yoda row did not resolve to yoda' },
      );

      await openComposeFresh();

      expect(await fieldValue('compose-from')).toBe(`${yoda.id} ${yoda.email}`);
    } finally {
      // One app instance for the whole run: leaving it in All Inboxes on
      // yoda's mail would greet every later spec with the wrong list.
      await closeComposeHard();
      await browser.execute((id) => {
        window.__MAIL_STORE__.getState().activateAccount(id, 'INBOX');
      }, luke.id);
      await browser.waitUntil(
        async () => (await browser.execute(() => window.__MAIL_STORE__.getState().activeMailbox)) === 'INBOX',
        { timeout: 30_000, interval: 300, timeoutMsg: 'never came back out of the unified inbox' },
      );
    }
  });

  // ── the Fastmail label ───────────────────────────────────────────────────

  const emailFieldLabel = () => browser.execute(() => {
    const input = document.querySelector('input[name="email"]');
    if (!input) return null;
    const field = input.closest('div')?.parentElement;
    return {
      label: field?.querySelector('label')?.textContent.trim() ?? null,
      placeholder: input.placeholder,
    };
  });

  const clickText = (text) => browser.execute((t) => {
    for (const btn of document.querySelectorAll('button')) {
      if (btn.offsetHeight > 0 && (btn.textContent || '').trim().startsWith(t)) { btn.click(); return true; }
    }
    return false;
  }, text);

  it('calls the field "Login Address" on the Fastmail add-account form', async function () {
    await openSettings();
    await clickSettingsNav('Accounts');
    expect(await clickText('Add Account')).toBe(true);
    await browser.pause(500);

    expect(await clickText('Fastmail')).toBe(true);
    await browser.pause(400);

    const fastmail = await emailFieldLabel();
    expect(fastmail).not.toBe(null);
    // Fastmail signs in with the @fastmail.com address and hands out aliases,
    // so "Email Address" is the wrong name for the field the reporter filled in.
    expect(fastmail.label).toBe('Login Address *');
    expect(fastmail.placeholder).toBe('you@fastmail.com');

    // The same form on another provider keeps the ordinary wording.
    expect(await clickText('Back')).toBe(true);
    await browser.pause(300);
    expect(await clickText('Zoho Mail')).toBe(true);
    await browser.pause(400);

    const zoho = await emailFieldLabel();
    expect(zoho.label).toBe('Email Address *');
    expect(zoho.placeholder).toBe('you@example.com');

    // Nothing was typed, so the header X closes outright — no discard prompt.
    // Settings itself is already gone: its "Add Account" hands off by closing.
    await browser.execute(() => {
      const header = [...document.querySelectorAll('h2')]
        .find((h) => ['Add Account', 'Choose Email Provider'].includes(h.textContent.trim()));
      header?.parentElement?.querySelector('button')?.click();
    });
    await browser.pause(400);
    const stillOpen = await browser.execute(() => !!document.querySelector('input[name="email"]'));
    expect(stillOpen).toBe(false);
  });

  it('calls the stored address "Login Address" for a Fastmail account in Settings', async function () {
    const accounts = await browser.execute(() =>
      JSON.parse(JSON.stringify(window.__MAIL_STORE__.getState().accounts || [])));
    const settingsLabel = () => browser.execute(() => {
      const input = document.querySelector('input[disabled]');
      const label = input?.closest('div')?.querySelector('label');
      return { label: label?.textContent.trim() ?? null, value: input?.value ?? null };
    });

    try {
      await openSettings();
      await clickSettingsNav('Accounts');
      await browser.pause(400);

      // The mock accounts are on 127.0.0.1, so this is the ordinary wording.
      const before = await settingsLabel();
      expect(before.value).toBe(luke.email);
      expect(before.label).toBe('Email Address');

      // A Fastmail account is one whose IMAP host says so — the login domain can
      // be anything, which is the case that made the report.
      await browser.execute((id) => {
        window.__MAIL_STORE__.setState((s) => ({
          accounts: (s.accounts || []).map((a) =>
            a.id === id ? { ...a, imapHost: 'imap.fastmail.com' } : a),
        }));
      }, luke.id);
      await browser.pause(400);

      const after = await settingsLabel();
      expect(after.value).toBe(luke.email);
      expect(after.label).toBe('Login Address');
    } finally {
      // Single app instance for the whole run: leaving a mock account pointed at
      // imap.fastmail.com would break every spec that syncs after this one.
      await browser.execute((list) => {
        window.__MAIL_STORE__.setState({ accounts: list });
      }, accounts);
      await browser.pause(300);
      await closeSettings();
    }

    const restored = await browser.execute((id) => {
      const a = (window.__MAIL_STORE__.getState().accounts || []).find((x) => x.id === id);
      return a?.imapHost ?? null;
    }, luke.id);
    expect(restored).toBe('127.0.0.1');
  });
});
