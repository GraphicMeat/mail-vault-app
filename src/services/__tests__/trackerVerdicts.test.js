// @vitest-environment jsdom
// scanTrackers parses the body with DOMParser, and mailStore binds window listeners.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../db', () => ({ getLocalEmailLight: vi.fn() }));

import * as db from '../db';
import { useMailStore } from '../../stores/mailStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { recordTrackerVerdict, backfillTrackerVerdicts, _resetTrackerBackfill } from '../trackerVerdicts';

const BEACON = '<p>hi</p><img src="https://u1.ct.sendgrid.net/wf/open?upn=abc" width="1" height="1">';
const CLEAN = '<p>hi</p><img src="https://example.com/logo.png" width="200">';

const header = (uid, extra = {}) => ({ uid, _accountId: 'acct-1', _mailbox: 'INBOX', messageId: `<m${uid}@x>`, ...extra });

function seedRows(rows) {
  useMailStore.setState({
    emails: rows, sortedEmails: rows, selectedEmail: null,
    activeAccountId: 'acct-1', activeMailbox: 'INBOX', unifiedInbox: false, emailCache: new Map(),
    accounts: [{ id: 'acct-1', email: 'a@b.c' }],
  });
}

describe('tracker verdicts', () => {
  beforeEach(() => {
    _resetTrackerBackfill();
    useSettingsStore.setState({ trackerAlerts: {} });
    db.getLocalEmailLight.mockReset();
  });

  it('records a verdict onto every row that is this message, and into settings', () => {
    seedRows([header(41), header(42)]);
    recordTrackerVerdict('acct-1-INBOX-41', [{ vendor: 'SendGrid' }, { vendor: 'SendGrid' }]);

    const { sortedEmails } = useMailStore.getState();
    expect(sortedEmails[0]._trackerInfo).toEqual({ count: 2, vendors: ['SendGrid'] });
    expect(sortedEmails[1]._trackerInfo).toBeUndefined();
    expect(useSettingsStore.getState().trackerAlerts['acct-1-INBOX-41']).toEqual({ count: 2, vendors: ['SendGrid'] });
  });

  it('backfills unopened rows from the vault without touching the network', async () => {
    seedRows([header(41), header(42)]);
    db.getLocalEmailLight.mockImplementation(async (_a, _m, uid) =>
      uid === 41 ? { html: BEACON, messageId: '<m41@x>' } : { html: CLEAN, messageId: '<m42@x>' });

    await backfillTrackerVerdicts([header(41), header(42)]);

    const rows = useMailStore.getState().sortedEmails;
    expect(rows[0]._trackerInfo.count).toBe(1);
    expect(rows[0]._trackerInfo.vendors).toEqual(['SendGrid']);
    expect(rows[1]._trackerInfo).toBeUndefined();
  });

  it('prefers a body already in the in-memory cache, and does not promote it out of prefetch', async () => {
    seedRows([header(41)]);
    const entry = { email: { html: BEACON, messageId: '<m41@x>' }, prefetchOnly: true };
    useMailStore.setState({ emailCache: new Map([['acct-1-INBOX-41', entry]]) });

    await backfillTrackerVerdicts([header(41)]);

    expect(db.getLocalEmailLight).not.toHaveBeenCalled();
    expect(useMailStore.getState().sortedEmails[0]._trackerInfo.count).toBe(1);
    // Reading it must not exempt the entry from the prefetch eviction pass.
    expect(entry.prefetchOnly).toBe(true);
  });

  it('discards a vault body whose Message-ID contradicts the header', async () => {
    seedRows([header(41)]);
    db.getLocalEmailLight.mockResolvedValue({ html: BEACON, messageId: '<someone-else@x>' });

    await backfillTrackerVerdicts([header(41)]);

    expect(useMailStore.getState().sortedEmails[0]._trackerInfo).toBeUndefined();
  });

  it('asks the vault once per message, however often the list re-renders', async () => {
    seedRows([header(41)]);
    db.getLocalEmailLight.mockResolvedValue({ html: CLEAN, messageId: '<m41@x>' });

    await backfillTrackerVerdicts([header(41)]);
    await backfillTrackerVerdicts([header(41)]);
    await backfillTrackerVerdicts([header(41)]);

    expect(db.getLocalEmailLight).toHaveBeenCalledTimes(1);
  });

  it('stops at the batch cap so a fling does not read the whole mailbox', async () => {
    const many = Array.from({ length: 30 }, (_, i) => header(100 + i));
    seedRows(many);
    db.getLocalEmailLight.mockResolvedValue({ html: CLEAN, messageId: null });

    await backfillTrackerVerdicts(many, { limit: 5 });

    expect(db.getLocalEmailLight).toHaveBeenCalledTimes(5);
  });
});
