/** Native compose handoff: use real Tauri window handles, never browser tabs. */
import { waitForApp, waitForEmails } from './helpers.js';
import { openComposeFresh, setField, fieldValue, testidPresent, clickBubble, closeComposeHard, mailStoreSet, modalOpen, settingsCall } from './composeHelpers.js';

describe('Connected Compose Detach', function () {
  this.timeout(120_000);
  let mainHandle;
  const setNativeSize = (width, height) => browser.executeAsync(async (w, h, done) => {
    try {
      const current = window.__TAURI__?.window?.getCurrentWindow?.();
      const LogicalSize = window.__TAURI__?.dpi?.LogicalSize;
      if (!current || !LogicalSize) throw new Error('Tauri window sizing API is unavailable');
      await current.setSize(new LogicalSize(w, h));
      done({ width: window.innerWidth, height: window.innerHeight });
    } catch (error) {
      done({ error: error?.message || String(error) });
    }
  }, width, height);

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
    await settingsCall('setSendDelay', 0);
  });

  it('keeps the embedded size stable and lets the keyboard resize corner change both axes', async () => {
    await openComposeFresh();
    await browser.waitUntil(() => browser.execute(() => {
      const style = document.querySelector('[data-testid="compose-modal"]')?.style;
      return Boolean(style?.width && style?.height);
    }), { timeout: 10_000, timeoutMsg: 'Embedded compose never recorded its initial size' });
    const before = await browser.execute(() => {
      const style = document.querySelector('[data-testid="compose-modal"]')?.style;
      return { width: Number.parseInt(style.width, 10), height: Number.parseInt(style.height, 10) };
    });
    await browser.pause(300);
    const stable = await browser.execute(() => {
      const style = document.querySelector('[data-testid="compose-modal"]')?.style;
      return { width: Number.parseInt(style.width, 10), height: Number.parseInt(style.height, 10) };
    });
    expect(stable).toEqual(before);

    await browser.execute(() => {
      const resize = document.querySelector('[data-testid="compose-window-resize"]');
      resize?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
      resize?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', shiftKey: true, bubbles: true, cancelable: true }));
    });
    await browser.waitUntil(() => browser.execute((size) => {
      const style = document.querySelector('[data-testid="compose-modal"]')?.style;
      return Number.parseInt(style.width, 10) === size.width + 24
        && Number.parseInt(style.height, 10) === size.height + 24;
    }, before), { timeout: 10_000, timeoutMsg: 'Keyboard resize corner did not update both compose dimensions' });
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

    const wideSize = await setNativeSize(1050, 760);
    if (wideSize.error) throw new Error(wideSize.error);
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

    const contextWideSize = await setNativeSize(1050, 760);
    if (contextWideSize.error) throw new Error(contextWideSize.error);
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

    const narrowSize = await setNativeSize(520, 760);
    if (narrowSize.error) throw new Error(narrowSize.error);
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

  it('queues a detached delayed send in main and restores the latest draft with Undo', async () => {
    await settingsCall('setSendDelay', 60);
    await openComposeFresh();
    await setField('compose-to', 'undo-detach@example.test');
    await setField('compose-subject', 'Detached delayed send');
    await browser.$('[data-testid="compose-detach"]').click();
    await browser.waitUntil(async () => (await browser.getWindowHandles()).length === 2, {
      timeout: 15_000, timeoutMsg: 'Compose did not detach before delayed send',
    });
    const detached = (await browser.getWindowHandles()).find(handle => handle !== mainHandle);
    await browser.switchToWindow(detached);
    await browser.waitUntil(() => testidPresent('compose-send'), {
      timeout: 15_000, timeoutMsg: 'Detached compose did not activate before delayed send',
    });
    await browser.$('[data-testid="compose-send"]').click();
    await browser.waitUntil(async () => (await browser.getWindowHandles()).length === 1, {
      timeout: 15_000, timeoutMsg: 'Detached compose stayed open after main accepted delayed send',
    });
    await browser.switchToWindow(mainHandle);
    await browser.waitUntil(() => browser.execute(() => {
      const pending = window.__MAIL_STORE__?.getState?.().pendingSend;
      return pending?.composeState?.initialData?.subject === 'Detached delayed send';
    }), { timeout: 15_000, timeoutMsg: 'Main did not retain the detached send in its undo queue' });
    await browser.$('[data-testid="undo-send-btn"]').click();
    await browser.waitUntil(modalOpen, { timeout: 15_000, timeoutMsg: 'Undo did not restore the detached draft' });
    expect(await fieldValue('compose-subject')).toBe('Detached delayed send');
    expect(await fieldValue('compose-to')).toBe('undo-detach@example.test');
  });
});
