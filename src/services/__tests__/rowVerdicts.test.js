// The list's side of the body scan: rows wear what the daemon answers
// (`body.verdicts`) without the list ever waiting for it, a row's own verdict
// is never replaced, and the backfill reads only bodies already on this
// machine. The rules are the daemon's (src-core body_scan, corpus-checked).
import { describe, it, expect, vi, beforeEach } from 'vitest';

// The real scan client (vitest.setup.js stubs it for the renderers' tests).
vi.unmock('../bodyScan');

const harness = vi.hoisted(() => ({ daemonCall: vi.fn(), patched: [] }));
vi.mock('../daemonClient', () => ({
  daemonCall: (...args) => harness.daemonCall(...args),
  DaemonError: class DaemonError extends Error {},
}));
vi.mock('../../stores/messageRows', () => ({
  patchEverywhere: (keys, mapRow) => harness.patched.push({ keys, mapRow }),
}));
vi.mock('../../stores/slices/unifiedHelpers', async (orig) => ({
  ...(await orig()),
  emailScopeKey: (row) => row?._key || null,
  resolveEmailLocation: (row) => row?._loc || null,
}));

const { annotateRowAlerts, recordTrackerSummary, recordLinkAlert, backfillTrackerVerdicts, _resetRowVerdicts } = await import('../rowVerdicts');
const { useSettingsStore } = await import('../../stores/settingsStore');

const settle = () => new Promise(r => setTimeout(r, 0));
const calls = (method) => harness.daemonCall.mock.calls.filter(([m]) => m === method).map(([, p]) => p);
const row = (key, extra = {}) => ({ _key: key, uid: Number(key.split('-').pop()), from: { name: 'support@paypal.com', address: 'scam@evil.example' }, ...extra });

beforeEach(() => {
  _resetRowVerdicts();
  harness.patched.length = 0;
  harness.daemonCall.mockReset();
  harness.daemonCall.mockImplementation(async (method, p) => {
    if (method === 'body.verdicts' && p.rows) {
      return { rows: Object.fromEntries(p.rows.map(r => [r.id, { _senderAlert: 'red', ...(r.key === 'a-INBOX-1' ? { _linkAlert: 'yellow' } : {}) }])), trackers: {} };
    }
    if (method === 'body.verdicts' && p.backfill) {
      return { rows: {}, trackers: Object.fromEntries(p.backfill.filter(b => b.uid === 41).map(b => [b.key, { count: 1, vendors: ['SendGrid'] }])) };
    }
    if (method === 'body.scan') return { trackers: [{ vendor: 'Mailchimp' }], count: 1, https: 0, summary: { count: 1, vendors: ['Mailchimp'] }, html: null, alerts: null, maxAlertLevel: null };
    throw new Error(method);
  });
  useSettingsStore.setState({ trackerAlerts: {}, linkAlerts: {}, linkSafetyEnabled: true });
});

describe('annotateRowAlerts', () => {
  it('never waits: a first pass asks once for the batch, and the answer reaches the rows by patch', async () => {
    const rows = [row('a-INBOX-1'), row('a-INBOX-2')];
    expect(annotateRowAlerts(rows, {})).toBe(rows);
    expect(rows[0]._senderAlert).toBeUndefined();
    await settle();
    const asked = calls('body.verdicts');
    expect(asked).toHaveLength(1);
    expect(asked[0].rows.map(r => r.key)).toEqual(['a-INBOX-1', 'a-INBOX-2']);
    // Only what the daemon reads of a row goes over.
    expect(Object.keys(asked[0].rows[0]).sort()).toEqual(['from', 'id', 'key', 'replyTo']);
    const [{ keys, mapRow }] = harness.patched;
    expect(keys.sort()).toEqual(['a-INBOX-1', 'a-INBOX-2']);
    expect(mapRow({ _key: 'a-INBOX-1' }, 'a-INBOX-1')).toMatchObject({ _senderAlert: 'red', _linkAlert: 'yellow' });
  });

  it('paints a known answer at once, and asks no more', async () => {
    annotateRowAlerts([row('a-INBOX-1')], {});
    await settle();
    const again = [row('a-INBOX-1')];
    annotateRowAlerts(again, {});
    expect(again[0]).toMatchObject({ _senderAlert: 'red', _linkAlert: 'yellow' });
    await settle();
    expect(calls('body.verdicts')).toHaveLength(1);
  });

  it('never replaces a verdict the row carries', async () => {
    annotateRowAlerts([row('a-INBOX-1')], {});
    await settle();
    const own = [row('a-INBOX-1', { _linkAlert: 'red', _senderAlert: null })];
    annotateRowAlerts(own, {});
    expect(own[0]._linkAlert).toBe('red');
    expect(own[0]._senderAlert).toBeNull();
  });

  it('a new verdict under a key, or the toggle, sends the stale answers back to the daemon', async () => {
    annotateRowAlerts([row('a-INBOX-1'), row('a-INBOX-2')], {});
    await settle();
    useSettingsStore.setState({ linkAlerts: { 'a-INBOX-2': 'red' } });
    annotateRowAlerts([row('a-INBOX-1'), row('a-INBOX-2')], {});
    await settle();
    expect(calls('body.verdicts')[1].rows.map(r => r.key)).toEqual(['a-INBOX-2']);
    useSettingsStore.setState({ linkSafetyEnabled: false });
    annotateRowAlerts([row('a-INBOX-1')], {});
    await settle();
    expect(calls('body.verdicts')).toHaveLength(3);
  });

  it('a failed call is not kept: the next pass asks again', async () => {
    harness.daemonCall.mockRejectedValueOnce(new Error('down'));
    annotateRowAlerts([row('a-INBOX-1')], {});
    await settle();
    annotateRowAlerts([row('a-INBOX-1')], {});
    await settle();
    expect(calls('body.verdicts')).toHaveLength(2);
  });
});

describe('recording', () => {
  it('a tracker summary and a link verdict reach every row of the message and the settings store', async () => {
    recordTrackerSummary('a-INBOX-5', { count: 2, vendors: ['X'] });
    recordLinkAlert('a-INBOX-5', 'red');
    expect(useSettingsStore.getState().trackerAlerts['a-INBOX-5']).toEqual({ count: 2, vendors: ['X'] });
    expect(useSettingsStore.getState().linkAlerts['a-INBOX-5']).toBe('red');
    expect(harness.patched.map(p => p.keys)).toEqual([['a-INBOX-5'], ['a-INBOX-5']]);
    // Before the settings document (written later) has it, the rows wear it.
    const rows = [row('a-INBOX-5')];
    annotateRowAlerts(rows, {});
    expect(rows[0]).toMatchObject({ _linkAlert: 'red', _trackerInfo: { count: 2, vendors: ['X'] } });
  });

  it('nothing without a key or a verdict', () => {
    recordTrackerSummary(null, { count: 1, vendors: [] });
    recordTrackerSummary('a-INBOX-6', null);
    recordLinkAlert('a-INBOX-6', null);
    expect(harness.patched).toEqual([]);
  });
});

describe('backfillTrackerVerdicts', () => {
  const header = (uid, extra = {}) => ({ _key: `acct-INBOX-${uid}`, _loc: { accountId: 'acct', mailbox: 'INBOX' }, uid, messageId: `<m${uid}@x>`, ...extra });

  it('asks the daemon to read the vault copy, by location and Message-ID, and records what tracks', async () => {
    await backfillTrackerVerdicts([header(41), header(42)], {});
    const [p] = calls('body.verdicts');
    expect(p.backfill).toEqual([
      { key: 'acct-INBOX-41', accountId: 'acct', mailbox: 'INBOX', uid: 41, messageId: '<m41@x>' },
      { key: 'acct-INBOX-42', accountId: 'acct', mailbox: 'INBOX', uid: 42, messageId: '<m42@x>' },
    ]);
    expect(useSettingsStore.getState().trackerAlerts).toEqual({ 'acct-INBOX-41': { count: 1, vendors: ['SendGrid'] } });
  });

  it('scans a prefetched body in memory instead, and not one that is another message', async () => {
    const emailCache = new Map([
      ['acct-INBOX-41', { email: { html: '<img src="x">', messageId: '<m41@x>' } }],
      ['acct-INBOX-43', { email: { html: '<img src="y">', messageId: '<other@x>' } }],
    ]);
    await backfillTrackerVerdicts([header(41), header(43)], { emailCache });
    expect(calls('body.verdicts')).toHaveLength(0);
    expect(calls('body.scan').map(p => p.html)).toEqual(['<img src="x">']);
    expect(useSettingsStore.getState().trackerAlerts['acct-INBOX-41']).toEqual({ count: 1, vendors: ['Mailchimp'] });
  });

  it('asks once per message, skips what is known, and stops at the cap', async () => {
    useSettingsStore.setState({ trackerAlerts: { 'acct-INBOX-50': { count: 1, vendors: [] } } });
    await backfillTrackerVerdicts([header(41), header(50), header(51, { _trackerInfo: { count: 1 } }), header(52, { _loc: null })], {});
    await backfillTrackerVerdicts([header(41)], {});
    expect(calls('body.verdicts').flatMap(p => p.backfill.map(b => b.uid))).toEqual([41]);
    const many = Array.from({ length: 30 }, (_, i) => header(100 + i));
    await backfillTrackerVerdicts(many, {}, { limit: 5 });
    expect(calls('body.verdicts')[1].backfill).toHaveLength(5);
  });
});
