/**
 * E2E: Connected Compose Editor — the TipTap body, its toolbar, and templates.
 *
 * Everything here is asserted against the editor's own HTML (`.ProseMirror`
 * innerHTML) rather than a screenshot: a mark that "looks bold" and a mark that
 * survives into the outgoing MIME are not the same thing, and only the second
 * one matters.
 *
 * Harness facts this leans on (see composeHelpers.js):
 *   - toolbar buttons act on mousedown so the editor keeps focus, which makes
 *     `.click()` a no-op → `clickToolbar()`;
 *   - WebDriver's Escape never reaches the webview → `pressEscape()`;
 *   - `expect(value, 'message')` throws in this runner, so every explanation
 *     lives in a comment above its assertion.
 */

import { waitForApp, waitForEmails } from './helpers.js';
import {
  MODAL,
  EDITOR,
  editorHtml,
  editorText,
  typeInBody,
  selectAllInBody,
  clickToolbar,
  toolbarState,
  setField,
  modalOpen,
  testidPresent,
  testidText,
  pressEscape,
  closeComposeHard,
  openComposeFresh,
  settingsCall,
} from './composeHelpers.js';

const TEMPLATE_NAME = 'E2E Dropzone Template';
const TEMPLATE_BODY = 'Thanks for the order, the meat is on its way.';

describe('Connected Compose Editor', function () {
  this.timeout(120_000);

  // ── local readers ────────────────────────────────────────────────────────

  /** The stored templates. `settingsCall` invokes a method; this reads a field. */
  const templates = () => browser.execute(() =>
    JSON.parse(JSON.stringify(window.__SETTINGS_STORE__.getState().emailTemplates || [])));

  const clickTestid = async (testid) => {
    const ok = await browser.execute((id) => {
      const el = document.querySelector(`[data-testid="${id}"]`);
      if (!el || el.offsetHeight === 0) return false;
      el.click();
      return true;
    }, testid);
    await browser.pause(250);
    return ok;
  };

  const templateItems = () => browser.execute(() =>
    [...document.querySelectorAll('[data-testid="compose-template-item"]')].map((b) => b.textContent.trim()));

  const clickTemplateNamed = async (name) => {
    const ok = await browser.execute((wanted) => {
      for (const btn of document.querySelectorAll('[data-testid="compose-template-item"]')) {
        if (btn.textContent.trim() === wanted) { btn.click(); return true; }
      }
      return false;
    }, name);
    await browser.pause(400);
    return ok;
  };

  const saveDisabled = () => browser.execute(() =>
    document.querySelector('[data-testid="compose-template-save"]')?.disabled ?? null);

  /** Open the footer's templates dropdown and prove it is on screen. */
  async function openTemplates() {
    expect(await clickTestid('compose-templates-btn')).toBe(true);
    try {
      await browser.waitUntil(() => testidPresent('compose-template-save-as'), {
        timeout: 10_000,
        interval: 200,
        timeoutMsg: 'templates dropdown never rendered',
      });
    } catch {
      throw new Error(
        'The templates button did not open the dropdown — "Save as Template" never ' +
        'rendered, so the footer control and the dropdown are out of sync',
      );
    }
  }

  const dropdownOpen = () => testidPresent('compose-template-save-as');

  /** Remove every stored template — the dropdown's empty state has to be earned. */
  async function clearTemplates() {
    for (const t of await templates()) {
      await settingsCall('removeEmailTemplate', t.id);
    }
  }

  before(async function () {
    await waitForApp();
    await waitForEmails();
    await clearTemplates();
  });

  afterEach(async function () {
    await closeComposeHard();
  });

  after(async function () {
    await clearTemplates();
  });

  // ── typing ───────────────────────────────────────────────────────────────

  it('shows the placeholder while the body is empty and drops it once text is typed', async function () {
    await openComposeFresh();

    const placeholder = () => browser.execute((sel) => {
      const p = document.querySelector(`${sel} p.is-editor-empty[data-placeholder]`);
      return p ? p.getAttribute('data-placeholder') : null;
    }, EDITOR);

    expect(await placeholder()).toBe('Write your message...');

    await typeInBody('no longer empty');

    // The decoration is per-node and only applies to an empty node, so a body
    // with text must not carry it — a stuck placeholder reads as lost input.
    expect(await placeholder()).toBe(null);
  });

  it('puts typed text into the editor', async function () {
    await openComposeFresh();
    await typeInBody('typed into the body');

    expect(await editorText()).toContain('typed into the body');
  });

  // ── inline marks ─────────────────────────────────────────────────────────

  const MARKS = [
    { prefix: 'Bold', tag: 'strong' },
    { prefix: 'Italic', tag: 'em' },
    { prefix: 'Underline', tag: 'u' },
    { prefix: 'Strikethrough', tag: 's' },
  ];

  for (const { prefix, tag } of MARKS) {
    it(`wraps the selection in <${tag}> and lights the ${prefix} button`, async function () {
      await openComposeFresh();
      await typeInBody(`mark me ${prefix}`);
      await selectAllInBody();

      const hit = await clickToolbar(prefix);
      expect(hit.found).toBe(true);

      const html = await editorHtml();
      expect(html).toContain(`<${tag}>`);
      // The button's own state is what tells the user the mark is on; it comes
      // from editor.isActive(), not from the click.
      expect((await toolbarState(prefix)).active).toBe(true);
    });
  }

  // ── block nodes ──────────────────────────────────────────────────────────

  const BLOCKS = [
    { prefix: 'Bullet List', tags: ['<ul>', '<li>'] },
    { prefix: 'Numbered List', tags: ['<ol>', '<li>'] },
    { prefix: 'Blockquote', tags: ['<blockquote>'] },
    { prefix: 'Code Block', tags: ['<pre', '<code'] },
  ];

  for (const { prefix, tags } of BLOCKS) {
    it(`wraps the paragraph with ${prefix}`, async function () {
      await openComposeFresh();
      await typeInBody(`block me ${prefix}`);
      await selectAllInBody();

      const hit = await clickToolbar(prefix);
      expect(hit.found).toBe(true);

      const html = await editorHtml();
      for (const tag of tags) {
        expect(html).toContain(tag);
      }
      expect((await toolbarState(prefix)).active).toBe(true);
    });
  }

  // ── links ────────────────────────────────────────────────────────────────

  it('wraps the selection in an anchor when Insert Link is used', async function () {
    await openComposeFresh();
    await typeInBody('link this');
    await selectAllInBody();

    // setLink() reads window.prompt; a null return is the user cancelling, so
    // the stub has to answer before the button is pressed.
    await browser.execute(() => {
      window.__origPrompt = window.prompt;
      window.prompt = () => 'https://example.com';
    });

    const hit = await clickToolbar('Insert Link');
    expect(hit.found).toBe(true);

    const html = await editorHtml();
    expect(html).toContain('href="https://example.com"');
    // Mail clients open links in a browser, never inside the message frame.
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');

    await browser.execute(() => {
      if (window.__origPrompt) window.prompt = window.__origPrompt;
    });
  });

  it('strips a mark with Clear Formatting', async function () {
    await openComposeFresh();
    await typeInBody('bold then plain');
    await selectAllInBody();

    expect((await clickToolbar('Bold')).found).toBe(true);
    expect(await editorHtml()).toContain('<strong>');

    await selectAllInBody();
    expect((await clickToolbar('Clear Formatting')).found).toBe(true);

    const html = await editorHtml();
    expect(html).not.toContain('<strong>');
    // The text itself must survive — clearing formatting is not clearing content.
    expect(await editorText()).toContain('bold then plain');
  });

  // ── history ──────────────────────────────────────────────────────────────

  it('enables Undo only after an edit, and Redo restores what Undo took', async function () {
    await openComposeFresh();

    // Nothing has been typed, so there is nothing to walk back to.
    expect((await toolbarState('Undo')).disabled).toBe(true);

    // One character on purpose: ProseMirror groups keystrokes on a 500ms timer,
    // and a WebDriver type slow enough to split a word would leave part of it
    // behind after a single Undo — which would read as a broken Undo.
    await typeInBody('Z');
    expect(await editorText()).toContain('Z');
    expect((await toolbarState('Undo')).disabled).toBe(false);

    expect((await clickToolbar('Undo')).found).toBe(true);
    expect((await editorText()).trim()).toBe('');

    expect((await toolbarState('Redo')).disabled).toBe(false);
    expect((await clickToolbar('Redo')).found).toBe(true);
    expect(await editorText()).toContain('Z');
  });

  it('leaves focus in the editor after a toolbar press', async function () {
    await openComposeFresh();
    await typeInBody('still focused');

    expect((await clickToolbar('Bold')).found).toBe(true);

    // The toolbar cancels its own mousedown so the caret never leaves; losing
    // focus here means the next keystroke goes nowhere.
    const focused = await browser.execute((sel) => {
      const editor = document.querySelector(sel);
      const active = document.activeElement;
      return !!editor && !!active && (editor === active || editor.contains(active));
    }, EDITOR);
    expect(focused).toBe(true);
  });

  // ── templates ────────────────────────────────────────────────────────────

  it('shows the empty state in the templates dropdown when nothing is stored', async function () {
    await clearTemplates();
    await openComposeFresh();
    await openTemplates();

    expect(await testidPresent('compose-templates-empty')).toBe(true);
    expect(await testidText('compose-templates-empty')).toContain('No templates yet');
  });

  it('saves the body as a template and inserts it back into a fresh message', async function () {
    await clearTemplates();
    await openComposeFresh();
    await typeInBody(TEMPLATE_BODY);
    await openTemplates();

    expect(await clickTestid('compose-template-save-as')).toBe(true);
    try {
      await browser.waitUntil(() => testidPresent('compose-template-name'), {
        timeout: 10_000,
        interval: 200,
        timeoutMsg: 'the template name input never appeared',
      });
    } catch {
      throw new Error('"Save as Template" did not swap the row for a name input — the dropdown never entered its saving state');
    }

    // An unnamed template cannot be found again, so Save stays out of reach.
    expect(await saveDisabled()).toBe(true);
    expect(await setField('compose-template-name', TEMPLATE_NAME)).toBe(true);
    expect(await saveDisabled()).toBe(false);

    expect(await clickTestid('compose-template-save')).toBe(true);

    let stored = null;
    try {
      await browser.waitUntil(async () => {
        stored = (await templates()).find((t) => t.name === TEMPLATE_NAME) || null;
        return stored !== null;
      }, {
        timeout: 10_000,
        interval: 250,
        timeoutMsg: 'the template was never written to the settings store',
      });
    } catch {
      throw new Error(
        `Save never reached settingsStore.addEmailTemplate — stored templates: ` +
        `${JSON.stringify(await templates())}`,
      );
    }

    // The stored body is the editor's plain text, not its HTML.
    expect(stored.body.trim()).toBe(TEMPLATE_BODY);
    // Saving closes the dropdown; leaving it open hides the message behind it.
    expect(await dropdownOpen()).toBe(false);

    // A fresh window proves the insert, not the text that was already typed.
    await openComposeFresh();
    await openTemplates();
    expect(await templateItems()).toContain(TEMPLATE_NAME);

    expect(await clickTemplateNamed(TEMPLATE_NAME)).toBe(true);
    try {
      await browser.waitUntil(async () => (await editorText()).includes(TEMPLATE_BODY), {
        timeout: 10_000,
        interval: 250,
        timeoutMsg: 'the template body never reached the editor',
      });
    } catch {
      throw new Error(
        `Clicking the template did not insert its body — the editor holds ` +
        `${JSON.stringify(await editorText())}`,
      );
    }

    await settingsCall('removeEmailTemplate', stored.id);
  });

  it('closes only the templates dropdown on Escape, leaving the message open', async function () {
    await openComposeFresh();
    await openTemplates();

    await pressEscape();

    expect(await dropdownOpen()).toBe(false);
    // The dropdown's Escape handler runs in capture phase and stops the event,
    // so the modal's own Escape (which minimizes to a bubble) must not fire.
    expect(await modalOpen()).toBe(true);
    expect(await browser.execute((sel) => document.querySelectorAll(sel).length, MODAL)).toBe(1);
  });

  it('closes the templates dropdown on a mousedown outside it', async function () {
    await openComposeFresh();
    await openTemplates();

    // The dropdown listens for mousedown, not click — a plain .click() on the
    // subject input would leave it open.
    await browser.execute(() => {
      document.querySelector('[data-testid="compose-subject"]')
        ?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    await browser.pause(300);

    expect(await dropdownOpen()).toBe(false);
    expect(await modalOpen()).toBe(true);
  });
});
