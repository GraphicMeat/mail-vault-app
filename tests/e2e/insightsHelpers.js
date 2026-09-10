import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { waitForApp } from './helpers.js';

/** Semantic handlers through the real visible controls. This driver cannot
 * reliably provide trusted native key activation; do not claim that coverage. */
async function waitForReachableControl(selector) {
  let state = 'missing';
  await browser.waitUntil(async () => {
    state = await browser.execute(sel => {
      const node = document.querySelector(sel);
      if (!node || node.disabled || node.closest('[hidden], [inert]')) return 'missing/disabled/inert';
      node.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      if (!rect.width || !rect.height || style.visibility === 'hidden' || style.display === 'none') return 'hidden';
      const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
      if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return 'outside viewport';
      const hit = document.elementFromPoint(x, y);
      return hit === node || node.contains(hit) ? 'ready' : `covered by ${hit?.tagName}`;
    }, selector);
    return state === 'ready';
  }, { timeout: 5000, interval: 50, timeoutMsg: `Control did not become reachable: ${selector}` })
    .catch(error => { throw new Error(`${error.message} (${state})`); });
}
export async function clickReachable(selector) {
  await waitForReachableControl(selector);
  const result = await browser.execute(sel => {
    const node = document.querySelector(sel);
    if (!node || node.disabled || node.closest('[hidden], [inert]')) return 'missing/disabled/inert';
    node.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    if (!rect.width || !rect.height || style.visibility === 'hidden' || style.display === 'none') return 'hidden';
    const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return 'outside viewport';
    const hit = document.elementFromPoint(x, y);
    if (hit !== node && !node.contains(hit)) return `covered by ${hit?.tagName}`;
    node.focus();
    if (document.activeElement !== node) return 'not focusable';
    node.click();
    return 'clicked';
  }, selector);
  assert.equal(result, 'clicked', `Reachable control: ${selector} (${result})`);
}
export async function setControl(selector, value) {
  await waitForReachableControl(selector);
  const result = await browser.execute((sel, next) => {
    const node = document.querySelector(sel);
    if (!node || node.disabled || node.closest('[hidden], [inert]')) return false;
    node.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    const rect = node.getBoundingClientRect();
    if (!rect.width || !rect.height || getComputedStyle(node).visibility === 'hidden') return false;
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    if (hit !== node && !node.contains(hit)) return false;
    node.focus();
    const prototype = node.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(node, next);
    node.dispatchEvent(new Event('input', { bubbles: true }));
    node.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, selector, String(value));
  assert.equal(result, true, `Reachable input: ${selector}`);
}
export async function waitForInsights() {
  await browser.waitUntil(() => browser.execute(() => ['ready', 'error'].includes(document.querySelector('[data-testid="insights-page"]')?.dataset.status)),
    { timeout: 60000, interval: 150, timeoutMsg: 'Insights local header inventory/query did not settle' });
  const state = await browser.execute(() => ({ status: document.querySelector('[data-testid="insights-page"]')?.dataset.status,
    alert: document.querySelector('[data-testid="insights-page"] [role="alert"]')?.textContent,
    session: window.__INSIGHTS_STATUS__?.(),
    native: window.__INSIGHTS_NATIVE_PROBE__?.outcomes }));
  assert.equal(state.status, 'ready', `Insights failed: ${JSON.stringify(state)}`);
}
export async function dismissOnboardingNotice() {
  if (await browser.execute(() => !!document.querySelector('[data-testid="onboarding-refresh-prompt"]'))) {
    await clickReachable('[data-testid="onboarding-refresh-prompt"] button[aria-label="Close"]');
    await browser.waitUntil(() => browser.execute(() => !document.querySelector('[data-testid="onboarding-refresh-prompt"]')), { timeout: 5000 });
  }
}
export async function openInsights() {
  await waitForApp();
  await dismissOnboardingNotice();
  await clickReachable('[data-testid="open-insights"]');
  await waitForInsights();
}
export async function setInsightsRange(start = '2026-09-01', end = '2026-09-30') {
  await setControl('[data-testid="insights-range-preset"]', 'custom');
  await waitForInsights();
  await setControl('[data-testid="insights-start-date"]', start);
  await setControl('[data-testid="insights-end-date"]', end);
  await clickReachable('[data-testid="insights-apply-range"]');
  await waitForInsights();
}
export async function nativeInvoke(command, args) {
  const result = await browser.executeAsync((cmd, payload, done) => {
    window.__TAURI__.core.invoke(cmd, payload).then(done).catch(error => done({ __error: String(error) }));
  }, command, args);
  assert.ok(!result?.__error, `${command}: ${result?.__error}`);
  return result;
}

/** Fixture preparation uses real IMAP extraction and the existing disk cache.
 * No Insights results, identities, dates or aggregation are injected. */
export async function cacheScenarioHeaders() {
  const stats = [];
  for (const account of browser.mockAccounts) {
    const response = await nativeInvoke('imap_get_mailboxes', { account });
    const mailboxes = response.mailboxes;
    assert.ok(Array.isArray(mailboxes));
    await nativeInvoke('save_mailbox_cache', { accountId: account.id, data: JSON.stringify({ mailboxes, fetchedAt: Date.now() }) });
    for (const folder of mailboxes) {
      const mailbox = folder.path || folder.name;
      if ((folder.attributes || folder.attrs || []).includes('\\Noselect')) continue;
      const status = await nativeInvoke('imap_check_mailbox_status', { account, mailbox });
      assert.equal(status.uidValidity, 101, 'Generation comes from the actual fixture server SELECT');
      let page = 1, hasMore = true, total = 0;
      const allUids = [];
      while (hasMore) {
        const headers = await nativeInvoke('imap_get_emails', { account, mailbox, page, limit: 200 });
        assert.ok(Array.isArray(headers.emails), `Provider headers for ${mailbox}`);
        assert.ok(headers.emails.length <= 200);
        total = headers.total;
        allUids.push(...headers.emails.map(header => header.uid));
        await nativeInvoke('save_email_cache', { accountId: account.id, mailbox,
          data: JSON.stringify({ emails: headers.emails, totalEmails: headers.total, lastSynced: Date.now(), uidValidity: status.uidValidity, uidNext: status.uidNext, highestModseq: status.highestModseq }) });
        hasMore = headers.hasMore;
        assert.ok(!hasMore || headers.emails.length > 0, 'Provider pagination must progress');
        page++;
      }
      await nativeInvoke('save_email_cache', { accountId: account.id, mailbox,
        data: JSON.stringify({ emails: [], totalEmails: total, serverUids: allUids, lastSynced: Date.now(), uidValidity: status.uidValidity, uidNext: status.uidNext, highestModseq: status.highestModseq }) });
      stats.push({ accountId: account.id, mailbox, loaded: allUids.length, total });
    }
  }
  console.log('[insights] Real provider header cache:', JSON.stringify(stats));
  return stats;
}
export async function readNativeSnapshot(accountIds = browser.mockAccounts.map(a => a.id)) {
  const begin = await nativeInvoke('insights_begin_snapshot', { accountIds });
  const rows = [], pageSizes = [];
  let cursor = null;
  try {
    do {
      const page = await nativeInvoke('insights_read_page', { snapshotId: begin.snapshotId, cursor });
      assert.ok(page.rows.length <= 1000, 'Native page size stays bounded');
      rows.push(...page.rows); pageSizes.push(page.rows.length); cursor = page.nextCursor;
    } while (cursor);
  } finally {
    await nativeInvoke('insights_release_snapshot', { snapshotId: begin.snapshotId });
  }
  return { ...begin, rows, pageSizes };
}
export async function summaryText() {
  return browser.execute(() => ({ total: document.querySelector('[data-testid="insights-total"]')?.textContent,
    counts: document.querySelector('[data-testid="insights-counts"]')?.textContent,
    coverage: document.querySelector('[data-testid="insights-coverage"]')?.textContent }));
}
export async function captureInsights(name) {
  const nativeWindow = await browser.executeAsync(done => {
    const win = window.__TAURI__.window.getCurrentWindow();
    Promise.all([win.isVisible(), win.isMinimized(), win.isFocused(), win.outerPosition()])
      .then(([visible, minimized, focused, position]) => done({ visible, minimized, focused, position }))
      .catch(error => done({ error: String(error) }));
  });
  console.log('[insights] Native capture window:', JSON.stringify(nativeWindow));
  assert.equal(nativeWindow.visible, true, `Capture requires a visible test window: ${JSON.stringify(nativeWindow)}`);
  assert.equal(nativeWindow.minimized, false, 'Capture requires an unminimized test window');
  const style = await browser.execute(() => {
    const page = document.querySelector('[data-testid="insights-page"]');
    return { visibilityState: document.visibilityState, font: getComputedStyle(document.body).fontFamily, pageDisplay: page ? getComputedStyle(page).display : null,
      sidebarWidth: document.querySelector('[data-testid="sidebar"]')?.getBoundingClientRect().width,
      page: page?.getBoundingClientRect().toJSON(),
      stylesheets: [...document.styleSheets].map(sheet => { try { return { href: sheet.href, rules: sheet.cssRules.length }; } catch { return { href: sheet.href, inaccessible: true }; } }) };
  });
  console.log('[insights] Computed native styles:', JSON.stringify(style));
  assert.equal(style.pageDisplay, 'flex', 'The actual native Insights stylesheet is loaded');
  assert.ok(style.stylesheets.some(sheet => sheet.rules > 0));
  const binary = resolve('target/debug/mailvault');
  const pids = execFileSync('pgrep', ['-f', binary], { encoding: 'utf8' }).trim().split('\n');
  const pid = pids.find(candidate => execFileSync('ps', ['-o', 'command=', '-p', candidate], { encoding: 'utf8' }).trim().split(' ')[0] === binary);
  assert.ok(pid, 'Only capture the exact disposable test app process');
  process.env.SHOTS_APP_BINARY = binary;
  process.env.SHOTS_OUT = browser.testDataDir;
  process.env.MAILVAULT_WINDOW_PID = pid;
  const { capture } = await import('../../scripts/screenshots/capture.js');
  const path = capture(`insights-${name}`);
  console.log(`[insights] native screenshot ${path}`);
}

export async function startFrameProbe() {
  await browser.execute(() => {
    if (window.__INSIGHTS_FRAME_PROBE__?.active) return;
    const probe = { active: true, last: performance.now(), frames: 0, maxFrameGap: 0, gaps: [], longTasks: [],
      workerPosts: [], workerReceipts: [], nativeReceipts: [], workers: [],
      initialVisibilityState: document.visibilityState, observedVisibilityStates: new Set([document.visibilityState]),
      longTasksSupported: typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes.includes('longtask') };
    const workerProto = globalThis.Worker?.prototype;
    if (workerProto) {
      probe.workerPostMessage = workerProto.postMessage;
      probe.workerAddEventListener = workerProto.addEventListener;
      probe.workerRemoveEventListener = workerProto.removeEventListener;
      probe.workerWrapper = function(message, ...args) {
        const started = performance.now();
        if (!probe.workers.some(entry => entry.worker === this)) {
          const listener = event => { if (probe.workerReceipts.length < 100) probe.workerReceipts.push({ type: event.data?.type, requestId: event.data?.requestId, at: performance.now() }); };
          probe.workerAddEventListener.call(this, 'message', listener);
          probe.workers.push({ worker: this, listener });
        }
        let result;
        try { result = probe.workerPostMessage.call(this, message, ...args); }
        finally {
          if (probe.workerPosts.length < 100) probe.workerPosts.push({ type: message?.type, requestId: message?.requestId, rows: Array.isArray(message?.copies) ? message.copies.length : null, startedAt: started, finishedAt: performance.now(), duration: performance.now() - started });
        }
        return result;
      };
      workerProto.postMessage = probe.workerWrapper;
    }
    probe.onVisibilityChange = () => probe.observedVisibilityStates.add(document.visibilityState);
    document.addEventListener('visibilitychange', probe.onVisibilityChange);
    if (probe.longTasksSupported) {
      probe.observer = new PerformanceObserver(list => { probe.longTasks.push(...list.getEntries().map(entry => entry.duration)); if (probe.longTasks.length > 100) probe.longTasks.splice(0, probe.longTasks.length - 100); });
      probe.observer.observe({ type: 'longtask', buffered: false });
    }
    function sample(now) {
      if (!probe.active) return;
      probe.observedVisibilityStates.add(document.visibilityState);
      const duration = now - probe.last;
      probe.maxFrameGap = Math.max(probe.maxFrameGap, duration);
      if (duration > 16) {
        let status = null; try { status = globalThis.__INSIGHTS_STATUS__?.(); } catch {}
        probe.gaps.push({ start: probe.last, end: now, duration, status: status?.status, loaded: status?.progress?.loaded, total: status?.progress?.total });
        probe.gaps.sort((a, b) => b.duration - a.duration); probe.gaps.length = Math.min(10, probe.gaps.length);
      }
      probe.last = now; probe.frames++;
      requestAnimationFrame(sample);
    }
    window.__INSIGHTS_FRAME_PROBE__ = probe;
    requestAnimationFrame(sample);
    if (workerProto && workerProto.postMessage !== probe.workerWrapper) throw new Error('Insights frame probe Worker wrapper was not installed');
  });
}
export async function stopFrameProbe() {
  return browser.executeAsync(done => requestAnimationFrame(() => {
    const probe = window.__INSIGHTS_FRAME_PROBE__;
    if (!probe || probe.cleaned) { done(null); return; }
    probe.active = false; probe.cleaned = true; probe.observer?.disconnect();
    for (const { worker, listener } of probe.workers) probe.workerRemoveEventListener.call(worker, 'message', listener);
    if (probe.workerWrapper && Worker.prototype.postMessage === probe.workerWrapper) Worker.prototype.postMessage = probe.workerPostMessage;
    document.removeEventListener('visibilitychange', probe.onVisibilityChange);
    probe.observedVisibilityStates.add(document.visibilityState);
    const visibilityStates = [...probe.observedVisibilityStates];
    const result = { frames: probe.frames, maxFrameGap: probe.maxFrameGap, longTasks: probe.longTasks, longTasksSupported: probe.longTasksSupported,
      workerPosts: probe.workerPosts, workerReceipts: probe.workerReceipts, nativeReceipts: probe.nativeReceipts, gaps: probe.gaps,
      initialVisibilityState: probe.initialVisibilityState, finalVisibilityState: document.visibilityState, observedVisibilityStates: visibilityStates,
      frameScheduling: visibilityStates.includes('hidden') ? 'Includes E2E hidden-window timer fallback; responsiveness proxy' : 'Native visible requestAnimationFrame callbacks' };
    delete window.__INSIGHTS_FRAME_PROBE__;
    done(result);
  }));
}

/** Observe shipped native calls through the VITE_E2E-only application seam.
 * Tauri internal invoke is non-writable and must not be monkey-patched.
 * Optionally delay delivery of one real reply.
 * This is a latency fault only: native execution and every returned byte remain
 * unchanged. Each test restores the transport and releases the held reply. */
export async function startNativeProbe(holdCommand = null) {
  const installed = await browser.execute(command => {
    if (window.__INSIGHTS_NATIVE_PROBE__) return false;
    const previous = window.__INSIGHTS_NATIVE_OBSERVER__;
    const probe = { previous, commands: [], outcomes: [], active: true, held: false, claimed: false, release: null };
    const observer = function (name, actual) {
      probe.commands.push(name);
      const result = name.startsWith('insights_') ? Promise.resolve(actual).then(value => {
        const frameProbe = window.__INSIGHTS_FRAME_PROBE__;
        if (frameProbe?.active && frameProbe.nativeReceipts.length < 100) frameProbe.nativeReceipts.push({ name, at: performance.now() });
        probe.outcomes.push({ name, ok: true, ...(frameProbe?.active ? { receivedAt: performance.now() } : {}) }); return value;
      }, error => { const frameProbe = window.__INSIGHTS_FRAME_PROBE__;
        if (frameProbe?.active && frameProbe.nativeReceipts.length < 100) frameProbe.nativeReceipts.push({ name, at: performance.now(), error: String(error) });
        probe.outcomes.push({ name, error, ...(frameProbe?.active ? { receivedAt: performance.now() } : {}) }); throw error; }) : actual;
      if (name !== command || probe.claimed) return result;
      probe.claimed = true;
      return Promise.resolve(result).then(value => {
        if (!probe.active) return value;
        return new Promise(resolve => {
          probe.held = true;
          probe.release = () => { probe.held = false; resolve(value); };
        });
      });
    };
    probe.observer = observer;
    window.__INSIGHTS_NATIVE_PROBE__ = probe;
    window.__INSIGHTS_NATIVE_OBSERVER__ = observer;
    return window.__INSIGHTS_NATIVE_OBSERVER__ === observer;
  }, holdCommand);
  assert.equal(installed, true, 'App-owned native observation/latency seam installed');
}
export async function waitForHeldNativeReply() {
  await browser.waitUntil(() => browser.execute(() => window.__INSIGHTS_NATIVE_PROBE__?.held === true),
    { timeout: 60000, interval: 100, timeoutMsg: 'Real native reply was not available to delay' });
}
export async function releaseNativeReply() {
  await browser.execute(() => window.__INSIGHTS_NATIVE_PROBE__?.release?.());
}
export async function stopNativeProbe() {
  return browser.execute(() => {
    const probe = window.__INSIGHTS_NATIVE_PROBE__;
    if (!probe) return [];
    probe.active = false;
    probe.release?.();
    if (window.__INSIGHTS_NATIVE_OBSERVER__ === probe.observer) window.__INSIGHTS_NATIVE_OBSERVER__ = probe.previous;
    delete window.__INSIGHTS_NATIVE_PROBE__;
    return probe.commands;
  });
}

export async function nativeProbeOutcomes() {
  return browser.execute(() => window.__INSIGHTS_NATIVE_PROBE__?.outcomes || []);
}
