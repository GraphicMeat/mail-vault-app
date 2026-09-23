import { describe, expect, it, vi } from 'vitest';
import { createComposeWindowOwner, composeSnapshotForTransfer, isComposeMessage } from '../composeWindow';

const snapshot = (subject = 'Draft') => ({
  to: 'to@example.test', cc: 'cc@example.test', bcc: 'bcc@example.test', subject,
  body: '<p>Body</p>', attachments: [{ filename: 'a.pdf' }], _accountId: 'account',
  _fromAddress: 'alias@example.test', _quotedHtml: '<p>part</p>', _contextHtml: '<p>thread</p>',
  _showContext: true, _draftUid: 12, _draftMailbox: 'Drafts', _composeDelay: 30,
  _scheduleDraft: { localTime: '2026-10-01T09:00', tz: 'Europe/Vilnius' },
});
const ready = (owner, id, token) => owner.receive({ composeId: String(id), token, requestId: 'ready', type: 'ready' });

describe('compose window ownership', () => {
  it('does not transfer source ownership until child initializes', async () => {
    const open = vi.fn().mockResolvedValue('compose-1');
    const emitTo = vi.fn().mockResolvedValue(undefined);
    const update = vi.fn();
    const owner = createComposeWindowOwner({ open, emitTo, update, close: vi.fn(), queueSend: vi.fn() });

    const handoff = owner.detach({ id: 7, mode: 'reply', snapshot: snapshot() });
    await vi.waitFor(() => expect(open).toHaveBeenCalled());
    const token = open.mock.calls[0][0].token;
    expect(update).not.toHaveBeenCalled();
    owner.receive({ composeId: '7', token, requestId: 'ready', type: 'ready' });
    await vi.waitFor(() => expect(emitTo).toHaveBeenCalled());
    expect(emitTo).toHaveBeenCalledWith('compose-1', 'compose-window-message', expect.objectContaining({ type: 'initialize' }));
    owner.receive({ composeId: '7', token, requestId: 'init', type: 'initialized' });
    await handoff;
    expect(update).toHaveBeenCalledWith(7, expect.objectContaining({ detached: true }));
  });

  it('fails a missing child acknowledgement without detaching the source', async () => {
    vi.useFakeTimers();
    const update = vi.fn();
    const close = vi.fn();
    const open = vi.fn().mockResolvedValue('compose-timeout');
    const owner = createComposeWindowOwner({ open, emitTo: vi.fn().mockResolvedValue(undefined), update, close, queueSend: vi.fn() });
    const handoff = owner.detach({ id: 70, mode: 'new', snapshot: snapshot() });
    const rejected = expect(handoff).rejects.toThrow('did not initialize');
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
    expect(update).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledWith('compose-timeout');
    vi.useRealTimers();
  });

  it('rejects a startup close and ignores an event with another token', async () => {
    const open = vi.fn().mockResolvedValue('compose-close');
    const update = vi.fn();
    const owner = createComposeWindowOwner({ open, emitTo: vi.fn().mockResolvedValue(undefined), update, close: vi.fn(), queueSend: vi.fn() });
    const handoff = owner.detach({ id: 71, mode: 'new', snapshot: snapshot() });
    const rejected = expect(handoff).rejects.toThrow('closed');
    await vi.waitFor(() => expect(open).toHaveBeenCalled());
    const token = open.mock.calls[0][0].token;
    expect(owner.receive({ composeId: '71', token: 'stale', requestId: 'bad', type: 'initialized' })).toBe(false);
    owner.receive({ composeId: '71', token, requestId: 'close', type: 'closed' });
    await rejected;
    // A child that closes before activation never took ownership, so the
    // source stays active instead of becoming a duplicate minimized draft.
    expect(update).not.toHaveBeenCalled();
  });

  it('keeps latest child snapshot on close and rejects stale window events', async () => {
    const update = vi.fn();
    const open = vi.fn().mockResolvedValue('compose-2');
    const owner = createComposeWindowOwner({ open, emitTo: vi.fn().mockResolvedValue(undefined), update, close: vi.fn(), queueSend: vi.fn() });
    const handoff = owner.detach({ id: 8, mode: 'new', snapshot: snapshot('old') });
    await vi.waitFor(() => expect(open).toHaveBeenCalled()); const token = open.mock.calls[0][0].token;
    ready(owner, 8, token);
    owner.receive({ composeId: '8', token, requestId: 'init', type: 'initialized' });
    await handoff;
    owner.receive({ composeId: 'old', token, requestId: 'x', type: 'snapshot', payload: snapshot('stale') });
    owner.receive({ composeId: '8', token, requestId: 'snap', type: 'snapshot', payload: snapshot('latest') });
    owner.receive({ composeId: '8', token, requestId: 'close', type: 'closed' });
    await Promise.resolve();
    expect(update).toHaveBeenLastCalledWith(8, expect.objectContaining({ minimized: true, detached: false, snapshot: expect.objectContaining({ subject: 'latest' }) }));
  });

  it('queues detached sends in main and ignores unknown settings writes', async () => {
    const queueSend = vi.fn();
    const update = vi.fn();
    const open = vi.fn().mockResolvedValue('compose-3');
    const owner = createComposeWindowOwner({ open, emitTo: vi.fn().mockResolvedValue(undefined), update, close: vi.fn(), queueSend });
    const handoff = owner.detach({ id: 9, mode: 'new', snapshot: snapshot() });
    await vi.waitFor(() => expect(open).toHaveBeenCalled()); const token = open.mock.calls[0][0].token;
    ready(owner, 9, token);
    owner.receive({ composeId: '9', token, requestId: 'init', type: 'initialized' });
    await handoff;
    owner.receive({ composeId: '9', token, requestId: 'send', type: 'send', payload: { snapshot: snapshot(), delay: 60 } });
    owner.receive({ composeId: '9', token, requestId: 'settings', type: 'settings', payload: { key: 'unknown', value: true } });
    await vi.waitFor(() => expect(queueSend).toHaveBeenCalledWith(expect.objectContaining({ subject: 'Draft' }), 60, expect.anything(), false));
    expect(update).not.toHaveBeenCalledWith(9, expect.objectContaining({ settings: expect.anything() }));
  });

  it('returns a synchronous queue failure to the child without tearing down its draft', async () => {
    const emitTo = vi.fn().mockResolvedValue(undefined);
    const update = vi.fn();
    const open = vi.fn().mockResolvedValue('compose-sync-error');
    const owner = createComposeWindowOwner({
      open, emitTo, update, close: vi.fn(),
      queueSend: () => { throw new Error('SMTP unavailable'); },
    });
    const handoff = owner.detach({ id: 91, mode: 'new', snapshot: snapshot() });
    await vi.waitFor(() => expect(open).toHaveBeenCalled());
    const token = open.mock.calls[0][0].token;
    ready(owner, 91, token);
    owner.receive({ composeId: '91', token, requestId: 'init', type: 'initialized' });
    await handoff;

    owner.receive({ composeId: '91', token, requestId: 'send', type: 'send', payload: { snapshot: snapshot() } });
    await vi.waitFor(() => expect(emitTo).toHaveBeenCalledWith(
      'compose-sync-error', 'compose-window-message', expect.objectContaining({ type: 'error', payload: 'SMTP unavailable' }),
    ));
    expect(update).toHaveBeenCalledWith(91, expect.objectContaining({ detached: true }));
  });

  it('keeps every compose-only value while ownership moves between windows', () => {
    const copied = composeSnapshotForTransfer(snapshot());

    expect(copied).toMatchObject({
      cc: 'cc@example.test', bcc: 'bcc@example.test', _fromAddress: 'alias@example.test',
      _quotedHtml: '<p>part</p>', _contextHtml: '<p>thread</p>', _draftUid: 12,
      _draftMailbox: 'Drafts', _composeDelay: 30,
      _scheduleDraft: { localTime: '2026-10-01T09:00', tz: 'Europe/Vilnius' },
    });
    expect(copied).not.toBeNull();
  });

  // A window is handed main's settings once, at detach. An upgrade made in
  // main afterwards has to reach it too, or its Premium panels stay locked.
  it('pushes a settings change made in main to a window, before and after it starts', async () => {
    const emitTo = vi.fn().mockResolvedValue(undefined);
    const open = vi.fn().mockResolvedValue('compose-settings');
    const owner = createComposeWindowOwner({ open, emitTo, update: vi.fn(), close: vi.fn(), queueSend: vi.fn() });
    const handoff = owner.detach({ id: 12, mode: 'new', snapshot: snapshot(), context: { settings: { billingProfile: null, language: 'de' } } });
    await vi.waitFor(() => expect(open).toHaveBeenCalled());
    const token = open.mock.calls[0][0].token;

    owner.pushSettings({ billingProfile: { premiumAccess: true } });
    ready(owner, 12, token);
    await vi.waitFor(() => expect(emitTo).toHaveBeenCalledWith('compose-settings', 'compose-window-message', expect.objectContaining({
      type: 'initialize', payload: expect.objectContaining({ settings: { billingProfile: { premiumAccess: true }, language: 'de' } }),
    })));
    owner.receive({ composeId: '12', token, requestId: 'init', type: 'initialized' });
    await handoff;

    owner.pushSettings({ billingProfile: null });
    expect(emitTo).toHaveBeenLastCalledWith('compose-settings', 'compose-window-message', expect.objectContaining({
      composeId: '12', token, type: 'settings-changed', payload: { billingProfile: null },
    }));
  });

  it('accepts only messages for the current compose session', () => {
    expect(isComposeMessage({ composeId: 'draft-7', type: 'snapshot' }, 'draft-7')).toBe(true);
    expect(isComposeMessage({ composeId: 'old-draft', type: 'snapshot' }, 'draft-7')).toBe(false);
    expect(isComposeMessage(null, 'draft-7')).toBe(false);
  });
});
