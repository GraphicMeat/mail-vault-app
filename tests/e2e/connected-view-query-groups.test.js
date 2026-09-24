/**
 * E2E: a view's OR groups reach the daemon and change what it finds.
 *
 * Two archived Luke messages, A and B. Typed as `A && B` the view wants both
 * subjects in one message, which none has; the preview must name neither.
 * Then B is dragged onto the OR button, which makes it a group of its own:
 * `A || B`, and the preview must name both. WebKit resolves the drop target
 * (`elementFromPoint`) and the daemon evaluates the saved notation.
 *
 * Also: a new view opens with an empty, focused name field, and a two-letter
 * `&&` word is found in the body. `of` is in every mock body ("Body of luke
 * message N") and in no subject or sender, so only the body match finds it.
 */
import { waitForApp, waitForEmails, switchToFolder, openSettings, closeSettings, clickSettingsNav } from './helpers.js';
import { clickSelectionAction } from './selectionBar.js';

const LUKE = 'luke@mock.test';

describe('View query OR groups', function () {
  this.timeout(300_000);
  let a = null;
  let b = null;
  let billing = null;

  const rows = () => browser.execute(() =>
    [...document.querySelectorAll('[data-testid="email-row"]')].map((row) => ({
      text: (row.innerText || '').replace(/\s*\n\s*/g, ' | ').trim(),
      icon: row.querySelector('[data-testid="msg-state-icon"]')?.getAttribute('data-state') || null,
    })));

  async function archive(subject) {
    const clicked = await browser.execute((needle) => {
      for (const row of document.querySelectorAll('[data-testid="email-row"]')) {
        if (!(row.innerText || '').includes(needle)) continue;
        row.querySelector('input[type="checkbox"]')?.click();
        return true;
      }
      return false;
    }, subject);
    expect(clicked).toBe(true);
    expect(await clickSelectionAction('archive')).toBe(true);
    await browser.waitUntil(async () => (await rows()).some((r) => r.text.includes(subject) && r.icon?.startsWith('archived')), {
      timeout: 60_000, interval: 300, timeoutMsg: `"${subject}" never became an archived row`,
    });
  }

  const previewSubjects = () => browser.execute(() => {
    const note = document.querySelector('[data-testid="view-preview-empty"], [data-testid="view-preview-rows"]');
    if (!note) return null;
    return [...document.querySelectorAll('[data-testid="view-preview-rows"] .view-preview-subject')].map((n) => n.textContent.trim());
  });

  const query = (text) => browser.execute((value) => {
    const input = document.querySelector('[data-testid="view-query"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  }, text);

  before(async function () {
    await waitForApp();
    await waitForEmails();
    await switchToFolder(LUKE, 'INBOX');
    // Two-digit subjects: "Luke message 1" is a substring of "Luke message 12".
    const fresh = (await rows()).filter((r) => /Luke message \d\d(?!\d)/.test(r.text)
      && !r.icon?.startsWith('archived') && !r.icon?.startsWith('local-only'));
    expect(fresh.length).toBeGreaterThan(3);
    [a, b] = [fresh[fresh.length - 3], fresh[fresh.length - 4]].map((r) => r.text.match(/Luke message \d\d/)[0]);
    await archive(a);
    await archive(b);
    // Three starters fill a free plan, and the + would refuse a fourth.
    billing = await browser.execute(() => {
      const before = window.__SETTINGS_STORE__.getState().billingProfile;
      window.__SETTINGS_STORE__.setState({ billingProfile: { hasSubscription: true, premiumAccess: true, status: 'active', clientAccessGranted: true } });
      return before ?? null;
    });
  });

  after(async function () {
    try { await closeSettings(); } catch { /* best effort */ }
    await browser.executeAsync((done) => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      invoke('daemon_rpc', { method: 'views.list', params: {} })
        .then((views) => Promise.all((views || []).filter((v) => !v.builtin)
          .map((v) => invoke('daemon_rpc', { method: 'views.delete', params: { id: v.id } }))))
        .then(() => done(), () => done());
    });
    await browser.execute((profile) => window.__SETTINGS_STORE__?.setState({ billingProfile: profile }), billing);
  });

  it('opens a new view with an empty focused name, and ORs dragged groups in the daemon', async function () {
    await openSettings();
    await browser.pause(400);
    await clickSettingsNav('Views');
    await browser.waitUntil(async () => browser.execute(() => {
      const button = document.querySelector('[data-testid="views-new"]');
      return !!button && !button.disabled;
    }), { timeout: 15_000, timeoutMsg: 'the + for a new view never became usable' });
    await browser.execute(() => document.querySelector('[data-testid="views-new"]').click());
    await browser.waitUntil(async () => browser.execute(() => !!document.querySelector('[data-testid="view-editor-form"]')),
      { timeout: 10_000, timeoutMsg: 'the view builder never opened' });

    const name = await browser.execute(() => {
      const input = document.querySelector('[data-testid="view-name"]');
      return { value: input.value, placeholder: input.placeholder, focused: document.activeElement === input };
    });
    expect(name.value).toBe('');
    expect(name.placeholder.length).toBeGreaterThan(0);
    expect(name.focused).toBe(true);

    await query(`${a} && ${b}`);
    // Anti-vacuity: the preview has answered for this query, and found neither.
    await browser.waitUntil(async () => {
      const subjects = await previewSubjects();
      return subjects !== null && !subjects.includes(a) && !subjects.includes(b);
    }, { timeout: 30_000, interval: 500, timeoutMsg: `"${a} && ${b}" should find neither message` });

    // tauri-wd's performActions dispatches MouseEvents only (mousedown /
    // mousemove / mouseup / click), never PointerEvents, so the driver cannot
    // make this drag. The sequence below is what WebKit delivers for a real
    // mouse drag with the chip holding pointer capture: every pointer event to
    // the chip, then a click on it, at coordinates over the OR button.
    const dragged = await browser.execute((word) => {
      const chip = [...document.querySelectorAll('.view-query-key')].find((n) => n.textContent.trim() === word);
      const or = document.querySelector('[data-testid="view-query-or"]');
      if (!chip || !or) return false;
      chip.scrollIntoView({ block: 'center' });
      const c = chip.getBoundingClientRect();
      const o = or.getBoundingClientRect();
      const from = { clientX: c.left + c.width / 3, clientY: c.top + c.height / 2 };
      const to = { clientX: o.left + o.width / 2, clientY: o.top + o.height / 2 };
      // The drop target is whatever WebKit puts under the release point.
      if (document.elementFromPoint(to.clientX, to.clientY)?.closest('[data-drop]')?.dataset.drop !== 'new') return false;
      const fire = (type, at) => chip.dispatchEvent(new PointerEvent(type,
        { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', button: 0, isPrimary: true, ...at }));
      fire('pointerdown', from);
      fire('pointermove', to);
      fire('pointerup', to);
      chip.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...to }));
      return true;
    }, b);
    expect(dragged).toBe(true);

    const groups = await browser.execute(() => [...document.querySelectorAll('[data-testid^="view-query-group-"]')]
      .map((g) => [...g.querySelectorAll('.view-query-key')].map((n) => n.textContent.trim())));
    expect(groups).toEqual([[a], [b]]);

    await browser.waitUntil(async () => {
      const subjects = await previewSubjects();
      return !!subjects && subjects.includes(a) && subjects.includes(b);
    }, { timeout: 60_000, interval: 500, timeoutMsg: `"${a} || ${b}" should find both messages` });

    await browser.execute(() => document.querySelector('[data-testid="view-editor-form"]').requestSubmit());
    const saved = await browser.waitUntil(async () => browser.executeAsync((done) => {
      window.__TAURI_INTERNALS__.invoke('daemon_rpc', { method: 'views.list', params: {} })
        .then((views) => done((views || []).find((v) => !v.builtin) || false), () => done(false));
    }), { timeout: 15_000, timeoutMsg: 'the new view was never stored' });
    expect(saved.def.query).toBe(`${a} || ${b}`);
    expect(saved.name.length).toBeGreaterThan(0);
  });

  it('finds a two-letter && word in the body, not only the headers', async function () {
    if (!(await browser.execute(() => !!document.querySelector('[data-testid="views-new"]')))) {
      await openSettings();
      await browser.pause(400);
      await clickSettingsNav('Views');
    }
    await browser.waitUntil(async () => browser.execute(() => {
      const button = document.querySelector('[data-testid="views-new"]');
      return !!button && !button.disabled;
    }), { timeout: 15_000, timeoutMsg: 'the + for a new view never became usable' });
    await browser.execute(() => document.querySelector('[data-testid="views-new"]').click());
    await browser.waitUntil(async () => browser.execute(() => !!document.querySelector('[data-testid="view-editor-form"]')),
      { timeout: 10_000, timeoutMsg: 'the view builder never opened' });

    // Control: a two-letter word the body does not hold finds nothing.
    await query(`${a} && zq`);
    await browser.waitUntil(async () => {
      const subjects = await previewSubjects();
      return subjects !== null && !subjects.includes(a);
    }, { timeout: 30_000, interval: 500, timeoutMsg: `"${a} && zq" should find nothing` });

    await browser.execute(() => [...document.querySelectorAll('.view-query-key')]
      .find((n) => n.textContent.trim() === 'zq')?.click());
    await query('of');
    const groups = await browser.execute(() => [...document.querySelectorAll('[data-testid^="view-query-group-"]')]
      .map((g) => [...g.querySelectorAll('.view-query-key')].map((n) => n.textContent.trim())));
    expect(groups).toEqual([[a, 'of']]);
    await browser.waitUntil(async () => (await previewSubjects())?.includes(a),
      { timeout: 30_000, interval: 500, timeoutMsg: `"${a} && of" should find ${a} by its body` });
  });
});
