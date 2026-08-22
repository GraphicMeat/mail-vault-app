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
