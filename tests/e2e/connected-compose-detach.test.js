/** Native compose handoff: use real Tauri window handles, never browser tabs. */
import { waitForApp, waitForEmails, switchToFolder, visibleRowSubjects } from './helpers.js';
import {
  openComposeFresh, setField, fieldValue, testidPresent, clickBubble, closeComposeHard, mailStoreSet, modalOpen, settingsCall,
  waitForNativeCompose, openComposeFreshNative, inlineComposeShown, closeNativeCompose,
  dropFiles, pdfFile, attachments, composeOverflow, MODAL, nativeComposeRpc, waitForLocalDraft,
} from './composeHelpers.js';

// A native window's field is present before its state has arrived: a second WebView2 hydrates slower
// than the first, so wait for the value, then assert it for the failure message.
async function expectFieldValue(testid, value) {
  await browser.waitUntil(async () => (await fieldValue(testid)) === value, {
    timeout: 15_000, interval: 200, timeoutMsg: `${testid} never held "${value}"`,
  }).catch(() => {});
  expect(await fieldValue(testid)).toBe(value);
}

// Diagnostics contain readiness/ownership booleans only, never message fields.
const readinessProbe = () => browser.execute(() => {
  const button = document.querySelector('[data-testid="compose-send"]');
  const error = document.querySelector('[data-testid="compose-error"]')?.textContent || '';
  return { ready: button?.closest('form')?.dataset.preparationReady || null, disabled: button?.disabled ?? null,
    hasTo: Boolean(document.querySelector('[data-recipient-field="to"] [data-testid="recipient-chip"]') || document.querySelector('[data-testid="compose-to"]')?.value),
    hasSubject: Boolean(document.querySelector('[data-testid="compose-subject"]')?.value),
    hasContext: Boolean(document.querySelector('[data-testid="compose-context-panel"]')),
    errorCategory: error.includes('prepare this message') ? 'preparation' : error.includes('recipient') ? 'recipient' : error ? 'other' : null };
});

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
    await browser.execute(() => {
      const fixture = window.__DETACH_PREPARATION_TEST__;
      if (!fixture) return;
      if (window.__TAURI__ === fixture.bridge) window.__TAURI__ = fixture.original;
      fixture.release();
      delete window.__DETACH_PREPARATION_TEST__;
    });
    await settingsCall('setSendDelay', 0);
    // A pop-out makes every later compose open in its own window.
    await settingsCall('setComposeOpenMode', 'app');
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
    await expectFieldValue('compose-subject', 'Native handoff');
    await expectFieldValue('compose-to', 'detach@example.test');
    await setField('compose-subject', 'Typed in detached window');

    const wideSize = await setNativeSize(1050, 760);
    if (wideSize.error) throw new Error(wideSize.error);
    expect(await testidPresent('compose-modal')).toBe(true);
    await browser.closeWindow();
    await browser.switchToWindow(mainHandle);
    await browser.waitUntil(() => testidPresent('compose-bubble'), { timeout: 15_000 });
    // The pop-out is remembered; this case pins the restore over the mail.
    await settingsCall('setComposeOpenMode', 'app');
    await clickBubble();
    expect(await fieldValue('compose-subject')).toBe('Typed in detached window');
  });

  it('projects child COW saves and account moves into main without a refresh', async () => {
    await closeComposeHard();
    const [account, other] = browser.mockAccounts;
    await switchToFolder(account.email, 'Drafts', { requireRows: false });
    await openComposeFresh(); await setField('compose-to', 'projection@example.test');
    await setField('compose-subject', 'Main projection before detach');
    await waitForLocalDraft(account.id, 'Main projection before detach');
    const initial = (await nativeComposeRpc('drafts.list')).managed.find(record => record.current?.entry?.subject === 'Main projection before detach');
    if (!initial) throw new Error('Native draft metadata missing before child projection control');
    await browser.$('[data-testid="compose-detach"]').click();
    await browser.switchToWindow(await waitForNativeCompose(mainHandle, 'Projection compose did not detach'));
    await browser.waitUntil(() => testidPresent('compose-subject'), { timeout: 15_000 });
    await setField('compose-subject', 'Child accepted COW projection');
    let current;
    await browser.waitUntil(async () => {
      current = (await nativeComposeRpc('drafts.list', { draftId: initial.draftId })).managed[0];
      return current?.current?.entry?.subject === 'Child accepted COW projection';
    }, { timeout: 15_000, timeoutMsg: 'Child native COW save did not commit' });
    expect(current.current.identity.uid).not.toBe(initial.current.identity.uid);
    await browser.switchToWindow(mainHandle);
    await browser.waitUntil(async () => (await visibleRowSubjects()).some(subject => subject.includes('Child accepted COW projection')),
      { timeout: 15_000, timeoutMsg: 'Main did not project the accepted child COW identity' });
    const rows = await browser.execute(id => window.__MAIL_STORE__.getState().localEmails.filter(row => row.draftId === id).map(row => ({ uid: row.uid, subject: row.subject })), initial.draftId);
    expect(rows).toEqual([{ uid: current.current.identity.uid, subject: 'Child accepted COW projection' }]);
    const child = (await browser.getWindowHandles()).find(handle => handle !== mainHandle);
    await browser.switchToWindow(child); await setField('compose-from', `${other.id} ${other.email}`);
    await browser.waitUntil(async () => (await nativeComposeRpc('drafts.list', { draftId: initial.draftId })).managed[0]?.current?.identity?.accountId === other.id,
      { timeout: 15_000, timeoutMsg: 'Child account move did not commit' });
    await browser.switchToWindow(mainHandle);
    await browser.waitUntil(async () => !(await visibleRowSubjects()).some(subject => subject.includes('Child accepted COW projection')),
      { timeout: 15_000, timeoutMsg: 'Main retained a stale source-account draft after child move' });
    await switchToFolder(other.email, 'Drafts', { requireRows: false });
    await browser.waitUntil(async () => (await visibleRowSubjects()).some(subject => subject.includes('Child accepted COW projection')),
      { timeout: 15_000, timeoutMsg: 'Destination account lost the child draft projection' });
  });

  it('keeps an attachment with a long name inside a pop-out compose window', async () => {
    await openComposeFresh();
    await browser.$('[data-testid="compose-detach"]').click();
    const detached = await waitForNativeCompose(mainHandle, 'Compose did not open a second native window');
    await browser.switchToWindow(detached);
    await browser.waitUntil(() => testidPresent('compose-subject'), {
      timeout: 15_000, timeoutMsg: 'Detached compose did not finish initialization',
    });
    const size = await setNativeSize(900, 700);
    if (size.error) throw new Error(size.error);

    const name = `${'9f2c1e7a-ad06-ad9ab29c911d_INBOX_47158_1_'.repeat(4)}Project report.pdf`;
    await dropFiles(`${MODAL} h2`, [pdfFile(name)]);
    await browser.waitUntil(async () => (await attachments()).includes(name), {
      timeout: 10_000, timeoutMsg: 'the long-named PDF was never attached',
    });

    const box = await composeOverflow();
    expect(box.sideways).toEqual([]);
    expect(box.chipPastModal).toBeLessThanOrEqual(0);
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
    // Keep the real main response pending through immediate handoff. The new
    // child must obtain its settings ACK from App and prepare independently.
    await browser.execute(() => {
      const original = window.__TAURI__;
      const fixture = { original, calls: 0 };
      const gate = new Promise(resolve => { fixture.release = resolve; });
      const invoke = (command, args) => {
        const response = original.core.invoke(command, args);
        if (command === 'daemon_rpc' && args?.method === 'compose.reply_context' && args?.params?.kind === 'message') {
          fixture.calls++;
          return Promise.resolve(response).then(async result => { await gate; return result; });
        }
        return response;
      };
      fixture.bridge = { ...original, core: { ...original.core, invoke } };
      window.__TAURI__ = fixture.bridge;
      window.__DETACH_PREPARATION_TEST__ = fixture;
      if (window.__TAURI__.core.invoke !== invoke) throw new Error('Cannot install pending preparation fixture');
    });
    const selection = { selectedEmail: source, selectedEmailId: source.uid, selectedThread: null };
    await mailStoreSet(selection);
    await browser.execute(() => document.activeElement?.blur());
    await mailStoreSet(selection);
    await browser.keys('r');
    await browser.waitUntil(modalOpen, { timeout: 15_000, timeoutMsg: 'Reply compose did not open' });
    await browser.waitUntil(() => browser.execute(() => window.__DETACH_PREPARATION_TEST__?.calls > 0), {
      timeout: 15_000, timeoutMsg: 'Main did not issue the deliberately pending native preparation',
    });
    expect((await readinessProbe()).ready).toBe('false');
    await browser.$('[data-testid="compose-detach"]').click();

    await browser.waitUntil(async () => (await browser.getWindowHandles()).length === 2, {
      timeout: 15_000,
      timeoutMsg: 'Reply compose did not open a second native window',
    });
    const detached = (await browser.getWindowHandles()).find(handle => handle !== mainHandle);
    await browser.switchToWindow(detached);
    try {
      await browser.waitUntil(() => testidPresent('compose-context-panel'), {
        timeout: 15_000, timeoutMsg: 'Detached reply did not restore its reading context',
      });
    } catch (error) {
      try { console.log('[detach-context-readiness]', await readinessProbe()); }
      catch { console.log('[detach-context-readiness-probe-failed]', true); }
      throw error;
    }
    expect((await readinessProbe()).ready).toBe('true');
    await expectFieldValue('compose-from', `${account.id} ${account.email}`);
    await expectFieldValue('compose-to', source.from.address);

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
    console.log('[detach-send-before-click]', await readinessProbe());
    await browser.$('[data-testid="compose-send"]').click();
    await browser.switchToWindow(mainHandle);
    try {
      await browser.waitUntil(() => browser.execute(() => {
        const pending = window.__MAIL_STORE__?.getState?.().pendingSend;
        return pending?.composeState?.initialData?.subject === 'Detached delayed send';
      }), { timeout: 15_000, timeoutMsg: 'Main never queued the delayed send after the child click' });
      await browser.waitUntil(async () => (await browser.getWindowHandles()).length === 1, {
        timeout: 15_000, timeoutMsg: 'Detached compose stayed open after confirmed main queue admission',
      });
    } catch (error) {
      try {
        console.log('[detach-main-queue-admitted]', await browser.execute(() => Boolean(window.__MAIL_STORE__?.getState?.().pendingSend)));
        if ((await browser.getWindowHandles()).includes(detached)) {
          await browser.switchToWindow(detached); console.log('[detach-send-after-click]', await readinessProbe());
        }
      } catch { console.log('[detach-send-readiness-probe-failed]', true); }
      throw error;
    }
    // The pop-out is remembered; this case pins Undo restoring over the mail.
    await settingsCall('setComposeOpenMode', 'app');
    await browser.$('[data-testid="undo-send-btn"]').click();
    await browser.waitUntil(modalOpen, { timeout: 15_000, timeoutMsg: 'Undo did not restore the detached draft' });
    await expectFieldValue('compose-subject', 'Detached delayed send');
    await expectFieldValue('compose-to', 'undo-detach@example.test');
  });

  it('remembers a pop-out: the next compose and the next reply open in a window of their own', async () => {
    await openComposeFresh();
    await browser.$('[data-testid="compose-detach"]').click();
    await browser.switchToWindow(await waitForNativeCompose(mainHandle, 'Compose did not open a second native window'));
    await browser.waitUntil(() => testidPresent('compose-subject'), {
      timeout: 15_000, timeoutMsg: 'Detached compose did not finish initialization',
    });
    await closeNativeCompose(mainHandle);

    const fresh = await openComposeFreshNative(mainHandle);
    expect(await inlineComposeShown()).toBe(false);
    await browser.switchToWindow(fresh);
    await browser.waitUntil(() => testidPresent('compose-subject'), {
      timeout: 15_000, timeoutMsg: 'The next compose did not initialize in its own window',
    });
    await closeNativeCompose(mainHandle);

    const account = browser.mockAccounts[0];
    const source = {
      uid: 636363,
      subject: 'Remembered window',
      from: { name: 'Window sender', address: 'window@example.test' },
      to: [{ address: account.email }],
      cc: [],
      replyTo: [],
      date: '2026-09-29T08:00:00.000Z',
      messageId: '<remembered-window@example.test>',
      text: 'The reply follows the window.',
      html: '<p>The reply follows the window.</p>',
      flags: ['\\Seen'],
      _accountId: account.id,
    };
    await closeComposeHard();
    const selection = { selectedEmail: source, selectedEmailId: source.uid, selectedThread: null };
    await mailStoreSet(selection);
    await browser.execute(() => document.activeElement?.blur());
    await mailStoreSet(selection);
    await browser.keys('r');
    const reply = await waitForNativeCompose(mainHandle, 'Reply did not open in a window of its own');
    expect(await inlineComposeShown()).toBe(false);
    await browser.switchToWindow(reply);
    // A window opens narrow, and the original-message panel folds away below
    // 564px, so the subject is what says this window is that reply.
    await browser.waitUntil(() => testidPresent('compose-subject'), {
      timeout: 15_000, timeoutMsg: 'The reply did not initialize in its own window',
    });
    await expectFieldValue('compose-subject', 'Re: Remembered window');
  });
});
