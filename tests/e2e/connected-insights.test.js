import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ImapFlow } from 'imapflow';
import { buildInsightsScenario } from './insightsFixture.js';
import { waitForApp, waitForEmails } from './helpers.js';
import { MOCK_PASSWORD, appDataDir } from './mockImap.js';
import { clickReachable, setControl, openInsights, waitForInsights, setInsightsRange,
  nativeInvoke, cacheScenarioHeaders, readNativeSnapshot, summaryText, captureInsights, startFrameProbe, stopFrameProbe, startNativeProbe, stopNativeProbe, waitForHeldNativeReply, releaseNativeReply, nativeProbeOutcomes } from './insightsHelpers.js';

const LARGE = process.env.E2E_INSIGHTS_LARGE === '1';
const expected = buildInsightsScenario({ inboxCount: LARGE ? 50000 : 700 }).firstAccountExpected;
const displayedTotal = async expectedTotal => {
  const text = (await summaryText()).total || '';
  const match = text.match(/^\s*([\d.,\s\u00a0]+)/);
  assert.ok(match, `Insights total is numeric: ${text}`);
  assert.equal(Number(match[1].replace(/[^\d]/g, '')), expectedTotal, `Insights total: ${text}`);
};

describe('Insights with real native mail data', function () {
  this.timeout(LARGE ? 900000 : 240000);
  let originalRows;

  before(async () => { await waitForApp(); await waitForEmails(); });

  it('opens from the real sidebar before any test fixture cache preparation', async () => {
    await startNativeProbe();
    try {
      await openInsights();
      const state = await summaryText();
      assert.ok(state.coverage, 'Available coverage is explained');
      await captureInsights('initial-coverage');
      await clickReachable('[data-testid="insights-close"]');
    } finally {
      const outcomes = await nativeProbeOutcomes();
      console.log('[insights] Initial native outcomes:', JSON.stringify(outcomes));
      await stopNativeProbe();
      assert.ok(outcomes.some(event => event.name === 'insights_begin_snapshot'), 'Observer must witness the real native snapshot attempt');
    }
  });

  it('inventories every real provider header beyond the visible page and across accounts/folders', async () => {
    const stats = await cacheScenarioHeaders();
    assert.equal(stats.find(s => s.accountId === browser.mockAccounts[0].id && s.mailbox === 'INBOX').loaded, LARGE ? 50000 : 700);
    const snapshot = await readNativeSnapshot();
    originalRows = snapshot.rows;
    const providerInbox = snapshot.rows.filter(row => row.source === 'server-cache' && row.accountId === browser.mockAccounts[0].id && row.mailbox === 'INBOX');
    assert.equal(providerInbox.length, LARGE ? 50000 : 700);
    assert.equal(new Set(providerInbox.map(row => row.uid)).size, LARGE ? 50000 : 700);
    assert.ok(providerInbox.every(row => row.uidValidity === 101), 'Every provider UID belongs to the actual selected generation');
    console.log('[insights] Physical sources:', JSON.stringify(snapshot.rows.reduce((counts, row) => ({ ...counts, [row.source]: (counts[row.source] || 0) + 1 }), {})));
    assert.ok(snapshot.rows.some(row => row.accountId === browser.mockAccounts[1].id && row.uid === 1));
    assert.ok(snapshot.rows.some(row => row.mailbox === 'Projects/Archive' && row.uid === 1));
    const boundary = snapshot.rows.find(row => row.messageId === '<insights-boundary@fixture.test>');
    assert.equal(new Date(boundary?.receivedAt).toISOString(), '2026-09-08T22:30:00.000Z');
    // Drafts/Trash/Junk exclusion is asserted by the visible logical totals;
    // the physical snapshot is allowed to retain their explicit special-use metadata.
    console.log('[insights] native page sizes:', JSON.stringify(snapshot.pageSizes));
  });

  it('shows literal totals, real recency geometry, top-thirty search and unchanged read flags', async () => {
    await startNativeProbe();
    let calls, scanTiming;
    try {
      await startFrameProbe();
      await openInsights(); await setInsightsRange();
    } finally {
      try { calls = await stopNativeProbe(); }
      finally { scanTiming = await stopFrameProbe(); }
    }
    assert.ok(calls.includes('insights_begin_snapshot'), 'Read-only assertion requires an observed real native scan');
    assert.equal(calls.some(name => /^(imap_get_email|imap_get_email_light|maildir_read|prefetch_attachments|smtp_send_email|archive_emails|imap_delete_email|bulk_delete_emails)$/.test(name)), false, `Entering charts only reads headers: ${calls.join(', ')}`);
    console.log('[insights] native scan/model/render frame timing:', JSON.stringify(scanTiming), 'inventory:', LARGE ? 50000 : 700);
    assert.ok(scanTiming.frames > 0, 'Frame callbacks remained responsive during scan');
    assert.ok(scanTiming.maxFrameGap <= 100, `Main-thread frame gap during scan/model/render: ${scanTiming.maxFrameGap}ms`);
    if (scanTiming.longTasksSupported) assert.ok(scanTiming.longTasks.every(duration => duration <= 100));
    let text = await summaryText();
    await displayedTotal(expected.received);
    assert.equal(text.counts, `${expected.received} received · 3 sent`);
    const originalMap = await browser.execute(() => ({
      nodes: document.querySelectorAll('.insights-map-node').length,
      omitted: [...document.querySelectorAll('.insights-map-section .insights-chart-caption')].some(node => /available in the list below/.test(node.textContent)),
      recentShown: [...document.querySelectorAll('.insights-map-node')].some(node => node.getAttribute('aria-label').includes('recent@insights.test')),
    }));
    assert.ok(originalMap.nodes > 0 && originalMap.nodes <= 30);
    assert.equal(originalMap.omitted, true); assert.equal(originalMap.recentShown, false, 'Recent ten-message contact begins outside the volume-based top thirty');
    await setControl('.insights-map-section input[type="search"]', 'contact');
    const geometry = await browser.execute(() => {
      const map = document.querySelector('.insights-map');
      const center = map?.querySelector('.insights-map-you')?.getBoundingClientRect();
      const measure = address => {
        const node = [...(map?.querySelectorAll('button') || [])].find(n => n.getAttribute('aria-label').includes(address));
        const rect = node?.querySelector('.insights-map-bubble')?.getBoundingClientRect();
        return rect && center ? { diameter: rect.width, distance: Math.hypot(rect.x + rect.width / 2 - center.x - center.width / 2, rect.y + rect.height / 2 - center.y - center.height / 2) } : null;
      };
      return { count: map?.querySelectorAll('button').length || 0, old: measure('old@insights.test'), recent: measure('recent@insights.test') };
    });
    assert.ok(geometry.count <= 30);
    assert.ok(geometry.old && geometry.recent, 'Both searched contact identities have reachable map nodes');
    assert.ok(Math.abs((geometry.old.diameter / geometry.recent.diameter) ** 2 - 10) < 0.05, 'Bubble area, not diameter, encodes 100 versus 10 messages');
    assert.ok(geometry.old.distance > geometry.recent.distance, 'Older contact stays farther from You');
    await setControl('.insights-map-section input[type="search"]', 'recent@insights.test');
    await clickReachable('.insights-sender-rows button[aria-label*="recent@insights.test"]');
    await waitForInsights();
    assert.match(await browser.execute(() => document.querySelector('[data-testid="insights-clear-sender"]')?.textContent || ''), /recent@insights.test/);
    await clickReachable('[data-testid="insights-tab-timeline"]');
    assert.ok(await browser.execute(() => document.querySelector('[data-testid="insights-clear-sender"]')?.textContent.includes('recent@insights.test')));
    await setControl('.insights-timeline .insights-chart-field:first-child select', 'day'); await waitForInsights();
    await clickReachable('.insights-timeline-hit[aria-label*="recent@insights.test"]');
    await browser.waitUntil(() => browser.execute(() => document.querySelectorAll('[data-testid="insights-match"]').length === 10), { timeout: 15000 });
    const timelineMatches = await browser.execute(() => [...document.querySelectorAll('[data-testid="insights-match"]')].map(node => ({ key: node.dataset.key, label: node.textContent })));
    assert.ok(timelineMatches.every(match => match.key.includes('recent-') && /Recent contact/.test(match.label)), 'Exact received-day cluster opens only its ten original messages');
    await browser.execute(() => document.querySelector('.insights-timeline')?.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }));
    await captureInsights('sender-timeline');
    await clickReachable('[data-testid="insights-clear-sender"]'); await waitForInsights();
    await clickReachable('[data-testid="insights-tab-map"]');
    await browser.execute(() => document.querySelector('.insights-map')?.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }));
    await captureInsights('map');
    const after = await readNativeSnapshot();
    assert.equal(after.rows.filter(row => row.flags.includes('\\Seen')).length, originalRows.filter(row => row.flags.includes('\\Seen')).length);
  });

  it('uses real sent shapes, automated filtering and exact daily totals', async () => {
    await setControl('[data-testid="insights-direction"]', 'sent'); await waitForInsights();
    await displayedTotal(3);
    await clickReachable('[data-testid="insights-tab-timeline"]');
    assert.ok(await browser.execute(() => document.querySelectorAll('rect[data-direction="sent"]').length > 0));
    await setControl('[data-testid="insights-direction"]', 'both'); await waitForInsights();
    await displayedTotal(expected.both);
    await clickReachable('[data-testid="insights-tab-activity"]');
    const cells = await browser.execute(() => [...document.querySelectorAll('button[data-date]')].map(button => ({ date: button.dataset.date, label: button.getAttribute('aria-label') })));
    assert.equal(cells.length, 30); assert.equal(new Set(cells.map(cell => cell.date)).size, 30);
    assert.match(cells.find(cell => cell.date === '2026-09-01').label, /100 received.*0 sent/);
    await browser.execute(() => document.querySelector('.insights-calendar')?.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }));
    await captureInsights('activity');
    await setControl('[data-testid="insights-direction"]', 'received'); await waitForInsights();
    await clickReachable('[data-testid="insights-hide-automated"]'); await waitForInsights();
    await displayedTotal(expected.receivedWithoutAutomated);
    await clickReachable('[data-testid="insights-hide-automated"]'); await waitForInsights();
  });

  it('opens exact account/folder messages from the day without UID cross-talk', async () => {
    await setControl('[data-testid="insights-accounts"]', browser.mockAccounts[1].id); await waitForInsights();
    await clickReachable('[data-testid="insights-tab-map"]');
    await setControl('.insights-map-section input[type="search"]', 'other-account@insights.test');
    await clickReachable('.insights-sender-rows button[aria-label*="other-account@insights.test"]');
    await waitForInsights();
    await clickReachable('[data-testid="insights-tab-activity"]');
    await clickReachable('button[data-date="2026-09-09"]');
    await browser.waitUntil(() => browser.execute(() => document.querySelectorAll('[data-testid="insights-match"]').length === 1), { timeout: 15000, interval: 100 });
    const identity = await browser.execute(() => ({ ...document.querySelector('[data-testid="insights-match"]').dataset }));
    assert.equal(identity.accountId, browser.mockAccounts[1].id);
    assert.equal(identity.mailbox, 'INBOX'); assert.equal(Number(identity.uid), 1);
    await clickReachable('[data-testid="insights-match"]');
    await browser.waitUntil(() => browser.execute(() => document.body.textContent.includes('INSIGHTS BODY account-b.')), { timeout: 30000, interval: 150 });
    assert.equal(await browser.execute(() => document.body.textContent.includes('INSIGHTS BODY old-1.')), false);
    await captureInsights('message-detail');
    await clickReachable('[data-testid="insights-reader"] [data-testid="close-viewer"]');
    await browser.waitUntil(() => browser.execute(key => !document.querySelector('[data-testid="insights-reader"]')
      && document.activeElement?.matches('[data-testid="insights-match"]')
      && document.activeElement?.dataset.key === key, identity.key), {
      timeout: 5000, interval: 100,
      timeoutMsg: 'The inner reader Close must remove Insights detail and return focus to the exact match row',
    });
    assert.equal(await browser.execute(() => !!document.querySelector('[data-testid="insights-matches"]')), true);
    await clickReachable('[data-testid="insights-match"]');
    await browser.waitUntil(() => browser.execute(() => document.querySelector('[data-testid="insights-reader"]')?.textContent.includes('INSIGHTS BODY account-b.')),
      { timeout: 30000, interval: 150 });
    await clickReachable('[data-testid="insights-close"]');
    await openInsights(); await setInsightsRange();
    if (await browser.execute(() => !!document.querySelector('[data-testid="insights-clear-sender"]'))) { await clickReachable('[data-testid="insights-clear-sender"]'); await waitForInsights(); }
    await setControl('[data-testid="insights-accounts"]', browser.mockAccounts[0].id); await waitForInsights();
  });

  it('shows incomplete coverage for a corrupt real header and recovers after repair', async () => {
    const accountId = browser.mockAccounts[0].id;
    const path = join(appDataDir(browser.testDataDir), 'email_cache', `${accountId.replace(/[^a-z0-9]/gi, '_')}_INBOX`, '1.json');
    const original = readFileSync(path);
    try {
      writeFileSync(path, '{ invalid fixture cache');
      await clickReachable('[data-testid="insights-refresh"]'); await waitForInsights();
      assert.match((await summaryText()).coverage, /Counts may be incomplete/i);
      const snapshot = await readNativeSnapshot();
      assert.equal(snapshot.rows.some(row => row.accountId === accountId && row.mailbox === 'INBOX' && row.uid === 1), false);
      await captureInsights('partial-header');
    } finally { writeFileSync(path, original); }
    await clickReachable('[data-testid="insights-refresh"]'); await waitForInsights();
    await displayedTotal(expected.received);
  });

  it('deduplicates real archived copies and retains a verified vault-only message', async () => {
    const account = browser.mockAccounts[0];
    const result = await nativeInvoke('archive_emails', { accountId: account.id, accountJson: JSON.stringify(account), mailbox: 'INBOX', uids: [112] });
    assert.equal(result.errors || 0, 0);
    await clickReachable('[data-testid="insights-refresh"]'); await waitForInsights();
    await displayedTotal(expected.received);
    const snapshot = await readNativeSnapshot();
    assert.ok(snapshot.rows.some(row => row.source === 'vault' && row.messageId === '<insights-boundary@fixture.test>'));
    const server = browser.mockImap[0];
    const client = new ImapFlow({ host: server.host, port: server.port, secure: false, auth: { user: account.email, pass: MOCK_PASSWORD }, logger: false });
    await client.connect();
    try { await client.mailboxOpen('INBOX'); await client.messageDelete('112', { uid: true }); } finally { await client.logout(); }
    // Refresh fixture caches via the actual provider after its real deletion.
    await nativeInvoke('save_email_cache', { accountId: account.id, mailbox: 'INBOX', data: JSON.stringify({ emails: [], removedUids: [112], totalEmails: (LARGE ? 50000 : 700) - 1 }) });
    await clickReachable('[data-testid="insights-refresh"]'); await waitForInsights();
    await displayedTotal(expected.received);
    await captureInsights('vault-only');
  });

  it('reads the verified vault-only message with the app connectivity pinned offline', async () => {
    const pinned = await browser.execute(() => {
      if (!window.__mvNet) return false;
      window.__mvNet.setOnline(false); return true;
    });
    assert.equal(pinned, true, 'Use the existing app-owned connectivity test seam');
    try {
      await browser.waitUntil(() => browser.execute(() => !!document.querySelector('[data-testid="offline-banner"]')), { timeout: 10000 });
      await clickReachable('[data-testid="insights-refresh"]'); await waitForInsights();
      await displayedTotal(expected.received);
      await clickReachable('[data-testid="insights-tab-map"]');
      await setControl('.insights-map-section input[type="search"]', 'boundary@insights.test');
      await clickReachable('.insights-sender-rows button[aria-label*="boundary@insights.test"]');
      await waitForInsights();
      await browser.waitUntil(() => browser.execute(() => document.querySelectorAll('[data-testid="insights-match"]').length === 1), { timeout: 15000 });
      await startNativeProbe();
      let calls;
      try {
        await clickReachable('[data-testid="insights-match"]');
        await browser.waitUntil(() => browser.execute(() => document.body.textContent.includes('INSIGHTS BODY insights-boundary.')), { timeout: 30000 });
        const custody = await browser.execute(() => document.querySelector('[data-testid="insights-reader"]')?.textContent || '');
        assert.match(custody, /Saved in your vault(?: and backup drive)?/);
        assert.match(custody, /Server copy not verified yet\./);
        assert.doesNotMatch(custody, /Your only copy|Someone else deleted the server copy/);
      } finally { calls = await stopNativeProbe(); }
      assert.ok(calls.some(name => /^maildir_read/.test(name)), 'Observer sees the actual vault reader before asserting absence of provider fetch');
      assert.equal(calls.some(name => /^(imap_get_email|imap_get_email_light)$/.test(name)), false, 'Vault-only reader makes no provider body request');
      await browser.execute(() => document.querySelector('[data-testid="insights-reader"]')?.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }));
      await captureInsights('offline-vault-reader');
      console.log('[insights] Offline uses existing __mvNet connectivity simulation; vault bytes and provider deletion are real.');
    } finally { await browser.execute(() => { window.__mvNet?.setOnline(true); window.__mvNet?.release?.(); }); }
    await clickReachable('[data-testid="insights-clear-sender"]'); await waitForInsights();
  });

  it('refreshes new provider mail exactly once and isolates the chosen account', async () => {
    const account = browser.mockAccounts[0], server = browser.mockImap[0];
    const client = new ImapFlow({ host: server.host, port: server.port, secure: false, auth: { user: account.email, pass: MOCK_PASSWORD }, logger: false });
    await client.connect();
    try {
      await client.append('INBOX', ['From: New correspondent <new-after-refresh@insights.test>', `To: ${account.email}`,
        'Subject: Arrived after Insights opened', 'Message-ID: <insights-new-after-refresh@fixture.test>',
        'Date: 09 Sep 2026 12:00:00 +0000', 'Content-Type: text/plain; charset=UTF-8', '', 'INSIGHTS BODY new-after-refresh.', ''].join('\r\n'), [], new Date('2026-09-09T12:00:00Z'));
    } finally { await client.logout(); }
    await cacheScenarioHeaders();
    await clickReachable('[data-testid="insights-refresh"]'); await waitForInsights();
    await displayedTotal(expected.received + 1);
    await clickReachable('[data-testid="insights-refresh"]'); await waitForInsights();
    await displayedTotal(expected.received + 1);
    await setControl('[data-testid="insights-accounts"]', browser.mockAccounts[1].id); await waitForInsights();
    await displayedTotal(1);
    await setControl('[data-testid="insights-accounts"]', browser.mockAccounts[0].id); await waitForInsights();
    await displayedTotal(expected.received + 1);
  });

  it('keeps the large inventory responsive with bounded mounted charts', async () => {
    await clickReachable('[data-testid="insights-tab-map"]');
    await setControl('.insights-map-section input[type="search"]', 'person');
    const timing = await browser.executeAsync(done => {
      const input = document.querySelector('.insights-map-section input[type="search"]');
      const samples = [];
      const initialVisibilityState = document.visibilityState;
      const visibilityStates = new Set([initialVisibilityState]);
      const trackVisibility = () => visibilityStates.add(document.visibilityState);
      document.addEventListener('visibilitychange', trackVisibility);
      const supported = typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes.includes('longtask');
      const observer = supported ? new PerformanceObserver(list => samples.push(...list.getEntries().map(entry => entry.duration))) : null;
      observer?.observe({ type: 'longtask', buffered: false });
      const start = performance.now();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'person39');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      const finish = () => {
        observer?.disconnect();
        trackVisibility(); document.removeEventListener('visibilitychange', trackVisibility);
        done({ responseMs: performance.now() - start, longTasksSupported: supported, longTasks: samples,
          initialVisibilityState, finalVisibilityState: document.visibilityState, observedVisibilityStates: [...visibilityStates],
          frameScheduling: visibilityStates.has('hidden') ? 'Includes E2E hidden-window timer fallback; responsiveness proxy' : 'Native visible requestAnimationFrame callbacks' });
      };
      const waitForCommittedFilter = () => {
        const nodes = [...document.querySelectorAll('.insights-map-node')];
        if (nodes.length === 1 && nodes[0].getAttribute('aria-label')?.includes('person39@insights.test')) return finish();
        if (performance.now() - start > 1000) return finish();
        requestAnimationFrame(waitForCommittedFilter);
      };
      requestAnimationFrame(waitForCommittedFilter);
    });
    assert.ok(timing.responseMs <= 200, `Ready-model filter response: ${timing.responseMs}ms`);
    if (timing.longTasksSupported) assert.ok(timing.longTasks.every(duration => duration <= 100));
    const count = await browser.execute(() => document.querySelectorAll('.insights-map-node').length);
    assert.equal(count, 1);
    assert.match(await browser.execute(() => document.querySelector('.insights-map-node')?.getAttribute('aria-label') || ''), /person39@insights\.test/);
    console.log('[insights] webview filter timing:', JSON.stringify(timing), 'inventory:', LARGE ? 50000 : 700);
    await clickReachable('[data-testid="insights-tab-timeline"]');
    assert.ok(await browser.execute(() => document.querySelectorAll('.insights-timeline-row').length < 30));
    await clickReachable('[data-testid="insights-tab-activity"]');
    await clickReachable('button[data-date="2026-09-04"]');
    await browser.waitUntil(() => browser.execute(() => document.querySelectorAll('[data-testid="insights-match"]').length > 0), { timeout: 30000 });
    const mounted = await browser.execute(() => ({ rows: document.querySelectorAll('[data-testid="insights-match"]').length, total: Number(document.querySelector('[data-testid="insights-match"]')?.closest('li')?.getAttribute('aria-setsize')) }));
    assert.equal(mounted.total, (LARGE ? 50000 : 700) - 112); assert.ok(mounted.rows <= 24, 'Matching-message list stays virtualized');
    await clickReachable('[data-testid="insights-close-matches"]');
  });

  it('discards a delayed real native page when closed and when account scope changes', async () => {
    await startNativeProbe('insights_read_page');
    try {
      await clickReachable('[data-testid="insights-refresh"]');
      await waitForHeldNativeReply();
      assert.equal(await browser.execute(() => document.querySelector('[data-testid="insights-page"]').dataset.status), 'loading');
      await clickReachable('[data-testid="insights-close"]');
      await releaseNativeReply();
      await browser.waitUntil(() => browser.execute(() => !document.querySelector('[data-testid="insights-page"]')), { timeout: 5000 });
    } finally { await stopNativeProbe(); }
    await openInsights(); await setInsightsRange();
    await displayedTotal(expected.received + 1);

    await startNativeProbe('insights_read_page');
    try {
      await clickReachable('[data-testid="insights-refresh"]');
      await waitForHeldNativeReply();
      await setControl('[data-testid="insights-accounts"]', browser.mockAccounts[1].id);
      await waitForInsights();
      await displayedTotal(1);
      await releaseNativeReply();
      await browser.executeAsync(done => requestAnimationFrame(() => requestAnimationFrame(() => done(true))));
      await displayedTotal(1);
      console.log('[insights] Race tests delay one actual native page response without replacing its data.');
    } finally { await stopNativeProbe(); }
    await setControl('[data-testid="insights-accounts"]', browser.mockAccounts[0].id); await waitForInsights();
  });

  it('distinguishes an unavailable real vault from empty mail and recovers the previous totals', async () => {
    const destination = mkdtempSync(join(browser.testDataDir, 'insights-detachable-vault-'));
    const disconnected = `${destination}-disconnected`;
    const before = await summaryText();
    let moved = false;
    try {
      await nativeInvoke('vault_move_to', { path: destination }); moved = true;
      await clickReachable('[data-testid="insights-refresh"]'); await waitForInsights();
      assert.equal((await summaryText()).total, before.total);
      renameSync(destination, disconnected);
      await clickReachable('[data-testid="insights-refresh"]');
      await browser.waitUntil(() => browser.execute(() => document.querySelector('[data-testid="insights-page"]')?.dataset.status === 'error'), { timeout: 30000 });
      assert.equal((await summaryText()).total, before.total, 'Keep the last result visible while clearly stale');
      assert.ok(await browser.execute(() => !!document.querySelector('[data-testid="insights-page"] [role="alert"]')));
      assert.equal(await browser.execute(() => !!document.querySelector('.insights-empty h2')), false, 'Unavailable storage is not an empty mailbox');
      assert.match((await summaryText()).coverage, /out of date|outdated|stale|refresh/i);
      await captureInsights('vault-disconnected');
    } finally {
      if (moved) {
        // In-flight background downloads can recreate the original path while
        // the detached copy is being inspected. Adopt the intact detached
        // vault before moving it back, so recovery never replaces or deletes
        // that recreated directory.
        if (existsSync(disconnected)) await nativeInvoke('vault_adopt', { path: disconnected });
        await nativeInvoke('vault_move_to_default', {});
      }
    }
    await clickReachable('[data-testid="insights-refresh"]'); await waitForInsights();
    assert.equal((await summaryText()).total, before.total);
  });

});
