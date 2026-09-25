/**
 * E2E: links in the compose body.
 *
 * Reported together: a pasted link swallowed everything typed after it; the
 * link button could only ask for a URL; and nothing let a link be opened,
 * changed or removed from where it sits. Every case asserts the editor's own
 * DOM, the `<a>` that goes out with the message.
 *
 * Harness facts (see composeHelpers.js): no native paste, so the paste is a
 * ClipboardEvent built in the page; no pointer events, so "hover" is a bubbling
 * `mouseover` dispatched on the link; toolbar buttons act on mousedown.
 */

import { waitForApp, waitForEmails } from './helpers.js';
import {
  EDITOR,
  editorText,
  typeInBody,
  clickToolbar,
  setField,
  fieldValue,
  modalOpen,
  testidPresent,
  pressEscape,
  closeComposeHard,
  openComposeFresh,
} from './composeHelpers.js';

const URL_PASTED = 'https://example.com/pasted';

describe('Connected Compose Links', function () {
  this.timeout(120_000);
  let mainHandle;

  /** Every `<a>` in the body, as the message will carry it. */
  const links = () => browser.execute((sel) =>
    [...(document.querySelector(sel)?.querySelectorAll('a') || [])].map((a) => ({
      href: a.getAttribute('href'),
      text: a.textContent,
      target: a.getAttribute('target'),
      rel: a.getAttribute('rel'),
    })), EDITOR);

  /** A plain-text paste into the body, the way the clipboard delivers one. */
  const pasteInBody = (text) => browser.execute((sel, value) => {
    const el = document.querySelector(sel);
    el.focus();
    const dt = new DataTransfer();
    dt.setData('text/plain', value);
    let ev = null;
    try { ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }); } catch { ev = null; }
    if (!ev || !ev.clipboardData) {
      ev = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'clipboardData', { value: dt });
    }
    el.dispatchEvent(ev);
    return ev.defaultPrevented;
  }, EDITOR, text);

  /** Collapsed caret inside the first link's text (ProseMirror follows selectionchange). */
  const caretInsideLink = () => browser.execute((sel) => {
    const el = document.querySelector(sel);
    const a = el?.querySelector('a');
    if (!a?.firstChild) return false;
    el.focus();
    const range = document.createRange();
    range.setStart(a.firstChild, 2);
    range.collapse(true);
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    return true;
  }, EDITOR);

  const hoverLink = () => browser.execute((sel) => {
    const a = document.querySelector(sel)?.querySelector('a');
    if (!a) return false;
    a.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true }));
    return true;
  }, EDITOR);

  const cardActions = () => browser.execute(() =>
    [...document.querySelectorAll('[data-testid="link-card"] button[data-link-action]')]
      .map((b) => ({ action: b.dataset.linkAction, label: b.textContent.trim() || b.getAttribute('aria-label'), disabled: b.disabled })));

  const clickCard = async (action) => {
    const ok = await browser.execute((a) => {
      const btn = document.querySelector(`[data-testid="link-card"] button[data-link-action="${a}"]`);
      if (!btn) return false;
      btn.click();
      return true;
    }, action);
    await browser.pause(250);
    return ok;
  };

  const clickTestid = async (id) => {
    const ok = await browser.execute((t) => {
      const el = document.querySelector(`[data-testid="${t}"]`);
      if (!el) return false;
      el.click();
      return true;
    }, id);
    await browser.pause(250);
    return ok;
  };

  // WebKit may type a trailing space as a no-break space; the words are what count.
  const bodyText = async () => ((await editorText()) || '').replace(/\u00a0/g, ' ');

  const waitFor = (fn, timeoutMsg) => browser.waitUntil(fn, { timeout: 10_000, interval: 200, timeoutMsg });

  /** Open the link panel from the toolbar and wait for it. */
  async function openLinkPanel() {
    expect((await clickToolbar('Insert Link')).found).toBe(true);
    await waitFor(() => testidPresent('link-editor'), 'the link panel never opened from the toolbar');
  }

  /** Fill the link panel and save it. */
  async function saveLinkPanel(text, href) {
    expect(await setField('link-editor-text', text)).toBe(true);
    expect(await setField('link-editor-url', href)).toBe(true);
    expect(await clickTestid('link-editor-save')).toBe(true);
    await waitFor(async () => !(await testidPresent('link-editor')), 'Save did not close the link panel');
  }

  const editorFocused = () => browser.execute((sel) => {
    const el = document.querySelector(sel);
    return !!el && (el === document.activeElement || el.contains(document.activeElement));
  }, EDITOR);

  before(async function () {
    await waitForApp();
    await waitForEmails();
    mainHandle = await browser.getWindowHandle();
  });

  afterEach(async function () {
    for (const handle of await browser.getWindowHandles()) {
      if (handle === mainHandle) continue;
      await browser.switchToWindow(handle);
      await browser.closeWindow();
    }
    await browser.switchToWindow(mainHandle);
    await closeComposeHard();
  });

  it('keeps text typed after a pasted link out of the link', async function () {
    await openComposeFresh();
    expect(await pasteInBody(URL_PASTED)).toBe(true);

    // Positive control: the paste itself made exactly this link. Without it,
    // "the typed text is not in a link" would pass on a paste that linked nothing.
    await waitFor(async () => (await links()).length === 1, 'the pasted URL never became a link');
    expect(await links()).toEqual([
      { href: URL_PASTED, text: URL_PASTED, target: '_blank', rel: 'noopener noreferrer' },
    ]);

    await typeInBody(' more text');

    // The link is still exactly the URL; the words after it are plain text.
    expect((await links()).map(({ href, text }) => ({ href, text }))).toEqual([{ href: URL_PASTED, text: URL_PASTED }]);
    expect(await bodyText()).toContain(`${URL_PASTED} more text`);
  });

  it('inserts a link with its own text from the toolbar, and edits both later', async function () {
    await openComposeFresh();
    await typeInBody('Visit ');

    await openLinkPanel();
    // A caret with nothing selected: nothing to prefill.
    expect(await fieldValue('link-editor-text')).toBe('');
    expect(await fieldValue('link-editor-url')).toBe('');
    // Nothing to remove yet.
    expect(await testidPresent('link-editor-remove')).toBe(false);
    await saveLinkPanel('our site', 'https://old.example');

    expect(await links()).toEqual([
      // Mail clients open links in a browser, never inside the message frame.
      { href: 'https://old.example', text: 'our site', target: '_blank', rel: 'noopener noreferrer' },
    ]);
    expect(await bodyText()).toContain('Visit our site');
    // Focus goes back to the message.
    expect(await editorFocused()).toBe(true);

    // The caret inside the link: the button edits that link, prefilled.
    expect(await caretInsideLink()).toBe(true);
    await browser.pause(150);
    await openLinkPanel();
    expect(await fieldValue('link-editor-text')).toBe('our site');
    expect(await fieldValue('link-editor-url')).toBe('https://old.example');
    expect(await testidPresent('link-editor-remove')).toBe(true);
    await saveLinkPanel('the new site', 'https://new.example');

    expect((await links()).map(({ href, text }) => ({ href, text }))).toEqual([
      { href: 'https://new.example', text: 'the new site' },
    ]);
    expect(await bodyText()).toContain('Visit the new site');
  });

  it('closes the link panel on Escape without touching the message', async function () {
    await openComposeFresh();
    await typeInBody('nothing to link');
    await openLinkPanel();

    await pressEscape();

    expect(await testidPresent('link-editor')).toBe(false);
    // The panel took the Escape; the compose window did not minimize.
    expect(await modalOpen()).toBe(true);
    expect(await links()).toEqual([]);
    expect(await bodyText()).toContain('nothing to link');
  });

  it('shows Open, Edit, Remove link and Remove link and text when a link is hovered', async function () {
    await openComposeFresh();
    await typeInBody('Read ');
    await openLinkPanel();
    await saveLinkPanel('the docs', 'https://docs.example');
    expect((await links()).length).toBe(1);

    expect(await hoverLink()).toBe(true);
    await waitFor(() => testidPresent('link-card'), 'hovering the link showed no card');
    const actions = await cardActions();
    expect(actions.map((a) => a.action)).toEqual(['open', 'edit', 'remove', 'remove-text']);
    expect(actions.every((a) => !a.disabled && a.label)).toBe(true);
    // The card names where the link goes.
    expect(await browser.execute(() => document.querySelector('[data-testid="link-card"]')?.textContent || ''))
      .toContain('docs.example');

    // Edit opens the same panel, prefilled from the hovered link.
    expect(await clickCard('edit')).toBe(true);
    await waitFor(() => testidPresent('link-editor'), 'Edit on the card did not open the link panel');
    expect(await fieldValue('link-editor-text')).toBe('the docs');
    expect(await fieldValue('link-editor-url')).toBe('https://docs.example');
    expect(await clickTestid('link-editor-cancel')).toBe(true);
    expect(await testidPresent('link-editor')).toBe(false);

    // Remove link: the words stay, the link goes.
    expect((await links()).length).toBe(1);
    expect(await hoverLink()).toBe(true);
    await waitFor(() => testidPresent('link-card'), 'the card did not come back');
    expect(await clickCard('remove')).toBe(true);
    expect(await links()).toEqual([]);
    expect(await bodyText()).toContain('Read the docs');

    // Link it again, then Remove link and text: both go.
    await typeInBody(' and ');
    await openLinkPanel();
    await saveLinkPanel('the blog', 'https://blog.example');
    expect((await links()).map((l) => l.text)).toEqual(['the blog']);
    expect(await hoverLink()).toBe(true);
    await waitFor(() => testidPresent('link-card'), 'the card did not show for the second link');
    expect(await clickCard('remove-text')).toBe(true);
    expect(await links()).toEqual([]);
    expect(await bodyText()).not.toContain('the blog');
    expect(await bodyText()).toContain('Read the docs and');
  });

  it('opens a hovered link through the system opener', async function () {
    await openComposeFresh();
    await typeInBody('See ');
    await openLinkPanel();
    // Nothing may launch on the runner, and the IPC under tauri-wd cannot be
    // intercepted from the page (a fetch stub was bypassed and Safari opened).
    // So the address is one the app treats as a web link (https:) but the
    // shell plugin's own check refuses (`https?://\w+`: no word character
    // after the slashes). The app hands it to the shell opener, the shell
    // refuses it, and the app's fallback, window.open, is what the page sees.
    const HREF = 'https://-refused-by-shell.example/page';
    await saveLinkPanel('the page', HREF);

    await browser.execute(() => {
      window.__linkOpened = [];
      window.__origOpen = window.open;
      window.open = (u) => { window.__linkOpened.push(String(u)); return null; };
    });

    try {
      expect(await hoverLink()).toBe(true);
      await waitFor(() => testidPresent('link-card'), 'hovering the link showed no card');
      expect(await clickCard('open')).toBe(true);
      await waitFor(async () => (await browser.execute(() => window.__linkOpened.length)) > 0,
        'Open link never reached the opener');
      expect(await browser.execute(() => window.__linkOpened)).toEqual([HREF]);
      // Opening is not editing: the link is untouched.
      expect((await links()).map(({ href, text }) => ({ href, text }))).toEqual([{ href: HREF, text: 'the page' }]);
    } finally {
      await browser.execute(() => {
        if (window.__origOpen) window.open = window.__origOpen;
      });
    }
  });

  it('works in a detached compose window, which may open links', async function () {
    await openComposeFresh();
    await browser.$('[data-testid="compose-detach"]').click();
    await browser.waitUntil(async () => (await browser.getWindowHandles()).length === 2, {
      timeout: 15_000,
      timeoutMsg: 'Compose did not open a second native window',
    });
    const detached = (await browser.getWindowHandles()).find((h) => h !== mainHandle);
    await browser.switchToWindow(detached);
    await browser.waitUntil(() => testidPresent('compose-subject'), {
      timeout: 15_000,
      timeoutMsg: 'Detached compose did not finish initialization',
    });

    // The window's capability must allow the shell opener. Probe it with an
    // address the plugin's own validation refuses, so nothing launches: a
    // missing permission fails first, as "... not allowed", and a granted one
    // reaches the plugin and fails its regex instead.
    // tauri-wd can surface the refusal as a WebDriverError of the execute
    // itself rather than as the page's own rejection; either carries the text.
    let probe;
    try {
      probe = await browser.executeAsync((done) => {
        window.__TAURI_INTERNALS__.invoke('plugin:shell|open', { path: 'not-a-link' })
          .then(() => done({ ok: true }), (e) => done({ ok: false, error: String((e && e.message) || e) }));
      });
    } catch (e) {
      probe = { ok: false, error: String((e && e.message) || e) };
    }
    console.log(`[compose-links] detached shell probe: ${JSON.stringify(probe)}`);
    expect(probe.ok).toBe(false);
    expect(probe.error).not.toContain('not allowed');
    expect(probe.error).toContain('regex validation');

    await typeInBody('Detached ');
    await openLinkPanel();
    await saveLinkPanel('link', 'https://detached.example');
    expect((await links()).map((l) => l.href)).toEqual(['https://detached.example']);
    expect(await hoverLink()).toBe(true);
    await waitFor(() => testidPresent('link-card'), 'hovering the link in the detached window showed no card');
    expect((await cardActions()).map((a) => a.action)).toEqual(['open', 'edit', 'remove', 'remove-text']);
  });
});
