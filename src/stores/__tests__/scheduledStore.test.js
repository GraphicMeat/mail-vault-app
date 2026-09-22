import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockDaemonCall = vi.fn();
vi.mock('../../services/daemonClient', () => ({
  daemonCall: (...args) => mockDaemonCall(...args),
  DaemonError: class DaemonError extends Error {},
}));

const { useScheduledStore } = await import('../scheduledStore');
const { zonedTimeToEpoch } = await import('../../utils/scheduledTime');

const ROW = {
  id: 'r1', accountId: 'a1', mailbox: 'Scheduled', uid: 1,
  envelope: '{"to":"x@example.com"}',
  localTime: '2026-10-01T09:00', tz: 'Europe/Vilnius',
  fireAt: zonedTimeToEpoch('2026-10-01T09:00', 'Europe/Vilnius'),
  status: 'queued', attempts: 0, lastError: '', createdAt: 0, updatedAt: 0,
};

beforeEach(() => {
  mockDaemonCall.mockReset();
  useScheduledStore.setState({ rows: [] });
});

describe('scheduledStore', () => {
  it('loads the queue from the daemon', async () => {
    mockDaemonCall.mockResolvedValueOnce([ROW]);
    await useScheduledStore.getState().loadRows();
    expect(mockDaemonCall).toHaveBeenCalledWith('scheduled.list', {});
    expect(useScheduledStore.getState().rows).toEqual([ROW]);
  });

  it('patches a row\'s status from a scheduled-send event, and nothing else', () => {
    useScheduledStore.setState({ rows: [ROW] });
    useScheduledStore.getState().applyEvent({ id: 'r1', status: 'sending' });
    expect(useScheduledStore.getState().rows).toEqual([{ ...ROW, status: 'sending' }]);
  });

  it('ignores an event for a row it does not have', () => {
    useScheduledStore.setState({ rows: [ROW] });
    useScheduledStore.getState().applyEvent({ id: 'unknown', status: 'sent' });
    expect(useScheduledStore.getState().rows).toEqual([ROW]);
  });

  it('ignores a malformed event rather than throwing', () => {
    useScheduledStore.setState({ rows: [ROW] });
    expect(() => useScheduledStore.getState().applyEvent(null)).not.toThrow();
    expect(useScheduledStore.getState().rows).toEqual([ROW]);
  });

  it('creates through scheduled.create and adds the returned row', async () => {
    mockDaemonCall.mockResolvedValueOnce(ROW);
    const params = {
      accountId: 'a1', account: { email: 'a1' }, email: { to: 'x@example.com' },
      localTime: ROW.localTime, tz: ROW.tz, fireAt: ROW.fireAt, sentMailbox: null,
    };
    const row = await useScheduledStore.getState().create(params);
    expect(mockDaemonCall).toHaveBeenCalledWith('scheduled.create', params);
    expect(row).toEqual(ROW);
    expect(useScheduledStore.getState().rows).toEqual([ROW]);
  });

  it('reschedules with exactly localTime, tz and fireAt — never a partial patch', async () => {
    const rescheduled = { ...ROW, localTime: '2026-11-01T09:00', tz: 'Europe/Vilnius', fireAt: 123 };
    mockDaemonCall.mockResolvedValueOnce(rescheduled);
    useScheduledStore.setState({ rows: [ROW] });
    await useScheduledStore.getState().reschedule('r1', { localTime: '2026-11-01T09:00', tz: 'Europe/Vilnius', fireAt: 123 });
    expect(mockDaemonCall).toHaveBeenCalledWith('scheduled.update', {
      id: 'r1', localTime: '2026-11-01T09:00', tz: 'Europe/Vilnius', fireAt: 123,
    });
    expect(useScheduledStore.getState().rows).toEqual([rescheduled]);
  });

  /// Saving an edited scheduled email: the whole rebuild (account, email,
  /// sentMailbox) and the time go over the SAME row id in one call.
  it('replaces a row in place through scheduled.update, rebuild and time together', async () => {
    const replaced = { ...ROW, envelope: '{"to":"y@example.com"}', localTime: '2026-11-01T09:00' };
    mockDaemonCall.mockResolvedValueOnce(replaced);
    useScheduledStore.setState({ rows: [ROW] });
    const fields = {
      account: { email: 'a1' }, email: { to: 'y@example.com' }, sentMailbox: 'Sent',
      localTime: '2026-11-01T09:00', tz: 'Europe/Vilnius', fireAt: 123,
    };
    await useScheduledStore.getState().replace('r1', fields);
    expect(mockDaemonCall).toHaveBeenCalledWith('scheduled.update', { id: 'r1', ...fields });
    expect(useScheduledStore.getState().rows).toEqual([replaced]);
  });

  it('leaves the row alone when the daemon refuses the replacement', async () => {
    mockDaemonCall.mockRejectedValueOnce(new Error('E_SCHEDULED_NOT_EDITABLE: already sent'));
    useScheduledStore.setState({ rows: [ROW] });
    await expect(useScheduledStore.getState().replace('r1', { account: {}, email: {} })).rejects.toThrow('E_SCHEDULED_NOT_EDITABLE');
    expect(useScheduledStore.getState().rows).toEqual([ROW]);
  });

  it('marks a row cancelled locally — the RPC answers null either way', async () => {
    mockDaemonCall.mockResolvedValueOnce(null);
    useScheduledStore.setState({ rows: [ROW] });
    await useScheduledStore.getState().cancel('r1');
    expect(mockDaemonCall).toHaveBeenCalledWith('scheduled.cancel', { id: 'r1' });
    expect(useScheduledStore.getState().rows[0].status).toBe('cancelled');
  });

  it('sendNow replaces the row with whatever the daemon answers', async () => {
    const sent = { ...ROW, status: 'sent' };
    mockDaemonCall.mockResolvedValueOnce(sent);
    useScheduledStore.setState({ rows: [ROW] });
    await useScheduledStore.getState().sendNow('r1');
    expect(mockDaemonCall).toHaveBeenCalledWith('scheduled.send_now', { id: 'r1' });
    expect(useScheduledStore.getState().rows).toEqual([sent]);
  });

  describe('recomputeFireAt', () => {
    it('pushes a corrected fireAt with the full {id, localTime, tz, fireAt} triple', async () => {
      const stale = { ...ROW, fireAt: ROW.fireAt - 3600_000 }; // wrong by an hour
      useScheduledStore.setState({ rows: [stale] });
      mockDaemonCall.mockResolvedValueOnce({ ...stale, fireAt: ROW.fireAt });

      await useScheduledStore.getState().recomputeFireAt();

      expect(mockDaemonCall).toHaveBeenCalledWith('scheduled.update', {
        id: 'r1', localTime: ROW.localTime, tz: ROW.tz, fireAt: ROW.fireAt,
      });
    });

    it('never wakes the daemon for a row whose fireAt is already correct', async () => {
      useScheduledStore.setState({ rows: [ROW] });
      await useScheduledStore.getState().recomputeFireAt();
      expect(mockDaemonCall).not.toHaveBeenCalled();
    });

    it('skips non-queued rows — a sent or cancelled row is never rescheduled', async () => {
      const sent = { ...ROW, status: 'sent', fireAt: ROW.fireAt - 3600_000 };
      useScheduledStore.setState({ rows: [sent] });
      await useScheduledStore.getState().recomputeFireAt();
      expect(mockDaemonCall).not.toHaveBeenCalled();
    });

    it('keeps the old fireAt (to retry next launch) when the push fails', async () => {
      const stale = { ...ROW, fireAt: ROW.fireAt - 3600_000 };
      useScheduledStore.setState({ rows: [stale] });
      mockDaemonCall.mockRejectedValueOnce(new Error('offline'));
      await expect(useScheduledStore.getState().recomputeFireAt()).resolves.toBeUndefined();
      expect(useScheduledStore.getState().rows).toEqual([stale]);
    });
  });

  describe('suggestTz', () => {
    it('asks the daemon about the address and resolves its facts to a zone', async () => {
      mockDaemonCall.mockResolvedValueOnce({ headerOffsetMinutes: null, headerDateMs: null, rememberedTz: 'Europe/Vilnius' });
      await expect(useScheduledStore.getState().suggestTz('bob@example.com'))
        .resolves.toEqual({ tz: 'Europe/Vilnius', source: 'history' });
      expect(mockDaemonCall).toHaveBeenCalledWith('scheduled.suggest_tz', { address: 'bob@example.com' });
    });

    it('is no suggestion, not an error, when the daemon fails or knows nothing', async () => {
      mockDaemonCall.mockRejectedValueOnce(new Error('offline'));
      await expect(useScheduledStore.getState().suggestTz('bob@example.com')).resolves.toBeNull();
      mockDaemonCall.mockResolvedValueOnce(null);
      await expect(useScheduledStore.getState().suggestTz('bob@example.com')).resolves.toBeNull();
    });
  });
});
