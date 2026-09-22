import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockDaemonCall = vi.fn();
vi.mock('../../services/daemonClient', () => ({
  daemonCall: (...args) => mockDaemonCall(...args),
  DaemonError: class DaemonError extends Error {},
}));

const { useAutoTagStore } = await import('../autoTagStore');

const KEEP_RULE = {
  id: 'r1', name: 'Receipts', instruction: 'receipts and invoices', constraints: {},
  tagId: 't1', inboxAction: 'keep', minConfidence: 0.7, allowRemote: false, provider: null,
  enabled: true, enabledAt: 100, createdAt: 0, updatedAt: 0,
};
const HIDE_RULE = { ...KEEP_RULE, id: 'r2', tagId: 't2', inboxAction: 'hide' };
const DISABLED_HIDE_RULE = { ...HIDE_RULE, id: 'r3', tagId: 't3', enabled: false };

beforeEach(() => {
  mockDaemonCall.mockReset();
  useAutoTagStore.setState({ rules: [], backfills: {} });
});

describe('autoTagStore', () => {
  it('loads the rule list from the daemon', async () => {
    mockDaemonCall.mockResolvedValueOnce([KEEP_RULE]);
    await useAutoTagStore.getState().loadRules();
    expect(mockDaemonCall).toHaveBeenCalledWith('auto_tags.list', {});
    expect(useAutoTagStore.getState().rules).toEqual([KEEP_RULE]);
  });

  it('round-trips a rule through create, update and delete', async () => {
    const draft = { name: 'Receipts', instruction: 'receipts', constraints: {}, tagId: 't1', inboxAction: 'keep', minConfidence: 0.7, allowRemote: false, provider: null, enabled: false };
    mockDaemonCall.mockResolvedValueOnce(KEEP_RULE);
    const created = await useAutoTagStore.getState().createRule(draft);
    expect(mockDaemonCall).toHaveBeenCalledWith('auto_tags.create', { rule: draft });
    expect(created).toEqual(KEEP_RULE);
    expect(useAutoTagStore.getState().rules).toEqual([KEEP_RULE]);

    const updated = { ...KEEP_RULE, name: 'Receipts v2' };
    mockDaemonCall.mockResolvedValueOnce(updated);
    await useAutoTagStore.getState().updateRule('r1', draft);
    expect(mockDaemonCall).toHaveBeenCalledWith('auto_tags.update', { id: 'r1', rule: draft });
    expect(useAutoTagStore.getState().rules).toEqual([updated]);

    mockDaemonCall.mockResolvedValueOnce(null);
    await useAutoTagStore.getState().deleteRule('r1');
    expect(mockDaemonCall).toHaveBeenCalledWith('auto_tags.delete', { id: 'r1' });
    expect(useAutoTagStore.getState().rules).toEqual([]);
  });

  // The important one: an enabled hide rule's tag is what makes
  // deriveDisplayRows (via autoTagInboxFilter) pull a message out of the
  // Inbox. A disabled rule must never contribute — see below.
  describe('hiddenTagIds', () => {
    it('collects the tag of every ENABLED hide rule', () => {
      useAutoTagStore.setState({ rules: [KEEP_RULE, HIDE_RULE] });
      expect(useAutoTagStore.getState().hiddenTagIds()).toEqual(new Set(['t2']));
    });

    it('excludes a disabled rule even if its inboxAction is hide', () => {
      useAutoTagStore.setState({ rules: [HIDE_RULE, DISABLED_HIDE_RULE] });
      expect(useAutoTagStore.getState().hiddenTagIds()).toEqual(new Set(['t2']));
    });

    it('is empty with no hide rules at all', () => {
      useAutoTagStore.setState({ rules: [KEEP_RULE] });
      expect(useAutoTagStore.getState().hiddenTagIds().size).toBe(0);
    });
  });

  describe('preview', () => {
    it('writes nothing — it just asks the daemon to evaluate and hands back candidates', async () => {
      const candidates = [
        { accountId: 'a', mailbox: 'INBOX', uid: 1, subject: 'Your receipt', matched: true, confidence: 0.92, refused: null },
        { accountId: 'a', mailbox: 'INBOX', uid: 2, subject: 'Newsletter', matched: false, confidence: null, refused: null },
      ];
      mockDaemonCall.mockResolvedValueOnce({ candidates });
      const rows = await useAutoTagStore.getState().preview({
        rule: { name: 'Receipts', instruction: 'receipts', constraints: {}, tagId: 't1', inboxAction: 'keep', minConfidence: 0.7, allowRemote: false, provider: null, enabled: false },
        accountId: 'a1', provider: { type: 'localGguf' },
      });
      expect(mockDaemonCall).toHaveBeenCalledWith('auto_tags.preview', expect.objectContaining({ accountId: 'a1', provider: { type: 'localGguf' } }));
      // preview is the ONLY call made — no assign/create/update RPC ever fires.
      expect(mockDaemonCall).toHaveBeenCalledTimes(1);
      expect(rows).toEqual(candidates);
      expect(rows[0].confidence).toBe(0.92);
    });

    it('previews a saved rule by id when no inline draft is given', async () => {
      mockDaemonCall.mockResolvedValueOnce({ candidates: [] });
      await useAutoTagStore.getState().preview({ ruleId: 'r1', accountId: 'a1' });
      expect(mockDaemonCall).toHaveBeenCalledWith('auto_tags.preview', expect.objectContaining({ ruleId: 'r1' }));
    });
  });

  describe('backfill + undo', () => {
    it('runs a backfill and records the batch it returns', async () => {
      const reply = { batchId: 'b1', ruleId: 'r1', processed: 10, total: 10, matched: 3, assigned: 3 };
      mockDaemonCall.mockResolvedValueOnce(reply);
      const result = await useAutoTagStore.getState().backfill({ ruleId: 'r1', accountId: 'a1' });
      expect(mockDaemonCall).toHaveBeenCalledWith('auto_tags.backfill', expect.objectContaining({ ruleId: 'r1', accountId: 'a1' }));
      expect(result).toEqual(reply);
      expect(useAutoTagStore.getState().backfills.r1).toEqual({ ...reply, done: true });
    });

    it('applies a progress event mid-run', () => {
      useAutoTagStore.getState().applyProgress({ batchId: 'b1', ruleId: 'r1', processed: 5, total: 10, matched: 1 });
      expect(useAutoTagStore.getState().backfills.r1).toMatchObject({ processed: 5, total: 10, done: false });
    });

    it('calls undo_backfill with the batch id, and clears the local offer', async () => {
      useAutoTagStore.setState({ backfills: { r1: { batchId: 'b1', processed: 10, total: 10, matched: 3, assigned: 3, done: true } } });
      mockDaemonCall.mockResolvedValueOnce({ unassigned: 3 });
      const result = await useAutoTagStore.getState().undoBackfill('r1', 'b1');
      expect(mockDaemonCall).toHaveBeenCalledWith('auto_tags.undo_backfill', { batchId: 'b1' });
      expect(result).toEqual({ unassigned: 3 });
      expect(useAutoTagStore.getState().backfills.r1).toBeUndefined();
    });
  });
});
