/** Native compose handoff: use real Tauri window handles, never browser tabs. */
import { waitForApp, waitForEmails } from './helpers.js';
import { openComposeFresh, setField, fieldValue, testidPresent, clickBubble, closeComposeHard, mailStoreSet, modalOpen } from './composeHelpers.js';

describe('Connected Compose Detach', function () {
  this.timeout(120_000);
  let mainHandle;

  before(async () => {
    await waitForApp();
    await waitForEmails();
    mainHandle = await browser.getWindowHandle();
  });

  afterEach(async () => {
    const handles = await browser.getWindowHandles();
    for (const handle of handles) {
      if (handle === mainHandle) continue;
      await browser.switchToWindow(handle);
      await browser.closeWindow();
    }
    await browser.switchToWindow(mainHandle);
  });

  it('detaches typed state into a resizable native window and preserves it after close', async () => {
    await openComposeFresh();
    await setField('compose-to', 'detach@example.test');
    await setField('compose-subject', 'Native handoff');
    await browser.$('[data-testid="compose-detach"]').click();

    await browser.waitUntil(async () => (await browser.getWindowHandles()).length === 2, {
      timeout: 15_000,
      timeoutMsg: 'Compose did not open a second native window',
    });
    const detached = (await browser.getWindowHandles()).find(handle => handle !== mainHandle);
    await browser.switchToWindow(detached);
    await browser.waitUntil(() => testidPresent('compose-subject'), {
      timeout: 15_000,
      timeoutMsg: 'Detached compose did not finish initialization',
    });
    expect(await fieldValue('compose-subject')).toBe('Native handoff');
    expect(await fieldValue('compose-to')).toBe('detach@example.test');
    await setField('compose-subject', 'Typed in detached window');

    await browser.setWindowSize(1050, 760);
    expect(await testidPresent('compose-modal')).toBe(true);
    await browser.closeWindow();
    await browser.switchToWindow(mainHandle);
    await browser.waitUntil(() => testidPresent('compose-bubble'), { timeout: 15_000 });
    await clickBubble();
    expect(await fieldValue('compose-subject')).toBe('Typed in detached window');
  });

  it('keeps reply reading context beside the complete composer and reachable after a native resize', async () => {
    const account = browser.mockAccounts[0];
    const source = {
      uid: 626262,
      subject: 'Detached reading context',
      from: { name: 'Context sender', address: 'context@example.test' },
      to: [{ address: account.email }],
      cc: [],
      replyTo: [],
      date: '2026-09-22T08:00:00.000Z',
      messageId: '<detached-context@example.test>',
      text: 'The context must remain visible.',
      html: '<p>The context must remain visible.</p>',
      flags: ['\\Seen'],
      _accountId: account.id,
    };

    await closeComposeHard();
    const selection = { selectedEmail: source, selectedEmailId: source.uid, selectedThread: null };
    await mailStoreSet(selection);
    await browser.execute(() => document.activeElement?.blur());
    await mailStoreSet(selection);
    await browser.keys('r');
    await browser.waitUntil(modalOpen, { timeout: 15_000, timeoutMsg: 'Reply compose did not open' });
    await browser.$('[data-testid="compose-detach"]').click();

    await browser.waitUntil(async () => (await browser.getWindowHandles()).length === 2, {
      timeout: 15_000,
      timeoutMsg: 'Reply compose did not open a second native window',
    });
    const detached = (await browser.getWindowHandles()).find(handle => handle !== mainHandle);
    await browser.switchToWindow(detached);
    await browser.waitUntil(() => testidPresent('compose-context-panel'), {
      timeout: 15_000,
      timeoutMsg: 'Detached reply did not restore its reading context',
    });

    await browser.setWindowSize(1050, 760);
    await browser.waitUntil(() => browser.execute(() => window.innerWidth >= 1000), {
      timeout: 10_000,
      timeoutMsg: 'Detached compose did not reach the requested wide size',
    });
    const wide = await browser.execute(() => {
      const main = document.querySelector('[data-testid="compose-main"]');
      const context = document.querySelector('[data-testid="compose-context"]');
      const header = document.querySelector('[role="dialog"] h2');
      if (!main || !context || !header) return null;
      return {
        mainRight: main.getBoundingClientRect().right,
        contextLeft: context.getBoundingClientRect().left,
        headerInMain: main.contains(header),
        contentDisplay: getComputedStyle(document.querySelector('[data-testid="compose-content"]')).display,
      };
    });
    expect(wide).not.toBeNull();
    expect(wide.headerInMain).toBe(true);
    expect(wide.contextLeft).toBeGreaterThanOrEqual(wide.mainRight - 1);
    expect(wide.contentDisplay).toBe('flex');

    await browser.setWindowSize(520, 760);
    await browser.waitUntil(() => browser.execute(() => window.innerWidth <= 540), {
      timeout: 10_000,
      timeoutMsg: 'Detached compose did not reach the requested narrow size',
    });
    const toggle = await browser.execute(() => {
      const el = document.querySelector('[data-testid="compose-context-toggle"]');
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return {
        visible: rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none',
        pressed: el.getAttribute('aria-pressed'),
      };
    });
    expect(toggle?.visible).toBe(true);
    await browser.execute(() => document.querySelector('[data-testid="compose-context-toggle"]')?.click());
    await browser.waitUntil(() => browser.execute(() =>
      document.querySelector('[data-testid="compose-context-toggle"]')?.getAttribute('aria-pressed') === 'false'
    ), { timeout: 10_000, timeoutMsg: 'Context toggle did not respond in the narrow native window' });
  });
});
