import { describe, expect, it, vi } from 'vitest';
import { createComposeWindowOwner as createOwner, composeSnapshotForTransfer, isComposeMessage } from '../composeWindow';

const testAccount = { id: 'account', email: 'me@example.test' };
const createComposeWindowOwner = options => createOwner({ acknowledgePreparation: async () => 4,
  checkPreparation: async () => ({ kind: 'ready', settingsVersion: 4, route: { delay: 60 } }),
  sendContext: () => ({ account: testAccount, senderSettings: { displayName: 'Me' }, remindAllowed: true }), ...options });
const prepareChecked = async (owner, id, token, emitTo) => {
  owner.receive({ composeId: String(id), token, requestId: 'checked', type: 'prepare-settings', payload: {
    purpose: 'send-check', attempt: 1, editorGeneration: 1, snapshot: snapshot(), authoredBodyText: 'Body', timeZone: 'UTC' } });
  await vi.waitFor(() => expect(emitTo).toHaveBeenCalledWith(expect.anything(), 'compose-window-message', expect.objectContaining({ requestId: 'checked', type: 'ack' })));
};
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

  // The window's "move back into the main window": the latest draft reopens in
  // main, open rather than minimized, and main hears of it before that
  // compose mounts, so it can stop the mount handing the draft straight back.
  it('reopens a draft moved back from its window in main, open, with its latest content', async () => {
    const order = [];
    const update = vi.fn((_id, patch) => order.push(['update', patch]));
    const attached = vi.fn(id => order.push(['attached', id]));
    const open = vi.fn().mockResolvedValue('compose-attach');
    const emitTo = vi.fn().mockResolvedValue(undefined);
    const owner = createComposeWindowOwner({ open, emitTo, update, close: vi.fn(), queueSend: vi.fn(), attached });
    const handoff = owner.detach({ id: 81, mode: 'reply', snapshot: snapshot('old') });
    await vi.waitFor(() => expect(open).toHaveBeenCalled()); const token = open.mock.calls[0][0].token;
    ready(owner, 81, token);
    owner.receive({ composeId: '81', token, requestId: 'init', type: 'initialized' });
    await handoff;
    order.length = 0;

    owner.receive({ composeId: '81', token, requestId: 'attach', type: 'attach', payload: snapshot('typed in the window') });
    await vi.waitFor(() => expect(attached).toHaveBeenCalledWith(81));
    expect(emitTo).toHaveBeenCalledWith('compose-attach', 'compose-window-message', expect.objectContaining({ requestId: 'attach', type: 'ack' }));
    expect(order.map(([what]) => what)).toEqual(['attached', 'update']);
    expect(order[1][1]).toMatchObject({
      minimized: false, detached: false, nativeLabel: null,
      snapshot: expect.objectContaining({ subject: 'typed in the window', bcc: 'bcc@example.test', _draftUid: 12 }),
      initialData: expect.objectContaining({ subject: 'typed in the window' }),
    });
  });

  it('still minimizes a closed window to a bubble without calling it a move back', async () => {
    const update = vi.fn();
    const attached = vi.fn();
    const open = vi.fn().mockResolvedValue('compose-close-bubble');
    const owner = createComposeWindowOwner({ open, emitTo: vi.fn().mockResolvedValue(undefined), update, close: vi.fn(), queueSend: vi.fn(), attached });
    const handoff = owner.detach({ id: 82, mode: 'new', snapshot: snapshot() });
    await vi.waitFor(() => expect(open).toHaveBeenCalled()); const token = open.mock.calls[0][0].token;
    ready(owner, 82, token);
    owner.receive({ composeId: '82', token, requestId: 'init', type: 'initialized' });
    await handoff;
    owner.receive({ composeId: '82', token, requestId: 'close', type: 'closed' });
    await vi.waitFor(() => expect(update).toHaveBeenLastCalledWith(82, expect.objectContaining({ minimized: true, detached: false })));
    expect(attached).not.toHaveBeenCalled();
  });

  it('refuses a move back while a send from the window is in flight', async () => {
    const emitTo = vi.fn().mockResolvedValue(undefined);
    const update = vi.fn();
    const attached = vi.fn();
    const open = vi.fn().mockResolvedValue('compose-attach-busy');
    const owner = createComposeWindowOwner({ open, emitTo, update, close: vi.fn(), queueSend: () => new Promise(() => {}), attached });
    const handoff = owner.detach({ id: 83, mode: 'new', snapshot: snapshot() });
    await vi.waitFor(() => expect(open).toHaveBeenCalled()); const token = open.mock.calls[0][0].token;
    ready(owner, 83, token);
    owner.receive({ composeId: '83', token, requestId: 'init', type: 'initialized' });
    await handoff;
    await prepareChecked(owner, 83, token, emitTo);
    owner.receive({ composeId: '83', token, requestId: 'send', type: 'send', payload: { attempt: 1, editorGeneration: 1 } });
    owner.receive({ composeId: '83', token, requestId: 'attach', type: 'attach', payload: snapshot() });
    await vi.waitFor(() => expect(emitTo).toHaveBeenCalledWith('compose-attach-busy', 'compose-window-message', expect.objectContaining({ requestId: 'attach', type: 'error' })));
    expect(attached).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalledWith(83, expect.objectContaining({ minimized: false, detached: false }));
  });

  it('queues detached sends in main and ignores unknown settings writes', async () => {
    const queueSend = vi.fn();
    const update = vi.fn();
    const open = vi.fn().mockResolvedValue('compose-3');
    const emitTo = vi.fn().mockResolvedValue(undefined);
    const owner = createComposeWindowOwner({ open, emitTo, update, close: vi.fn(), queueSend });
    const handoff = owner.detach({ id: 9, mode: 'new', snapshot: snapshot() });
    await vi.waitFor(() => expect(open).toHaveBeenCalled()); const token = open.mock.calls[0][0].token;
    ready(owner, 9, token);
    owner.receive({ composeId: '9', token, requestId: 'init', type: 'initialized' });
    await handoff;
    await prepareChecked(owner, 9, token, emitTo);
    owner.receive({ composeId: '9', token, requestId: 'send', type: 'send', payload: { attempt: 1, editorGeneration: 1 } });
    owner.receive({ composeId: '9', token, requestId: 'settings', type: 'settings', payload: { key: 'unknown', value: true } });
    await vi.waitFor(() => expect(queueSend).toHaveBeenCalledWith(expect.objectContaining({ subject: 'Draft' }), 60, expect.anything(), false, expect.objectContaining({ account: testAccount })));
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

    await prepareChecked(owner, 91, token, emitTo);
    owner.receive({ composeId: '91', token, requestId: 'send', type: 'send', payload: { attempt: 1, editorGeneration: 1 } });
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

it('preserves newer child snapshot when a delayed older revision arrives before attach', async () => {
  const update = vi.fn(); const open = vi.fn().mockResolvedValue('compose-revisions');
  const owner = createComposeWindowOwner({ open, emitTo: vi.fn().mockResolvedValue(undefined), update, close: vi.fn(), queueSend: vi.fn() });
  const old = { ...snapshot(), _draftId: 'stable', _draftRevision: 2, _draftAcceptedRevision: 2, _draftUid: 20 };
  const latest = { ...old, body: 'x', _draftRevision: 3, _draftAcceptedRevision: 2 };
  const handoff = owner.detach({ id: 101, mode: 'new', snapshot: old });
  await vi.waitFor(() => expect(open).toHaveBeenCalled()); const token = open.mock.calls[0][0].token;
  ready(owner, 101, token); owner.receive({ composeId: '101', token, requestId: 'init', type: 'initialized' }); await handoff;
  owner.receive({ composeId: '101', token, requestId: 'new', type: 'snapshot', payload: latest });
  owner.receive({ composeId: '101', token, requestId: 'old', type: 'snapshot', payload: old });
  owner.receive({ composeId: '101', token, requestId: 'attach', type: 'attach' });
  await vi.waitFor(() => expect(update).toHaveBeenCalledWith(101, expect.objectContaining({ detached: false, initialData: expect.objectContaining({ body: 'x', _draftRevision: 3 }) })));
});


it.each(['pending', 'unknown', 'complete'])('awaits main discard ownership and carries %s without editable recovery on lost ACK', async cleanup => {
  let settle; const discarded = new Promise(resolve => { settle = resolve; });
  const discard = vi.fn(() => discarded); const open = vi.fn().mockResolvedValue('terminal-child');
  const update = vi.fn(); const remove = vi.fn(); const close = vi.fn(); const emitTo = vi.fn().mockResolvedValue(undefined);
  const owner = createComposeWindowOwner({ open, emitTo, update, remove, close, discard, queueSend: vi.fn() });
  const handoff = owner.detach({ id: 22, snapshot: { ...snapshot(), _draftId: 'terminal' } });
  await vi.waitFor(() => expect(open).toHaveBeenCalled()); const token = open.mock.calls[0][0].token;
  ready(owner, 22, token); owner.receive({ composeId: '22', token, type: 'initialized', requestId: 'init' }); await handoff;
  update.mockClear();
  owner.receive({ composeId: '22', token, type: 'discard', requestId: 'discard', payload: { ...snapshot('latest'), _draftId: 'terminal' } });
  await vi.waitFor(() => expect(discard).toHaveBeenCalledTimes(1));
  expect(remove).not.toHaveBeenCalled();
  owner.receive({ composeId: '22', token, type: 'discard', requestId: 'duplicate' });
  owner.recover(22); emitTo.mockRejectedValueOnce(Error('lost ACK'));
  settle({ draftId: 'terminal', discarded: cleanup !== 'unknown', cleanup });
  await vi.waitFor(() => expect(close).toHaveBeenCalled());
  expect(discard).toHaveBeenCalledWith(expect.objectContaining({ _draftId: 'terminal', subject: 'latest' }), 22);
  expect(update.mock.calls.some(([, patch]) => !patch.snapshot?._draftCleanupOnly && patch.detached === false)).toBe(false);
});

it('binds token-fenced preparation ACK to accepted in-flight settings', async () => {
  let release;
  let accepted = false;
  const open = vi.fn().mockResolvedValue('compose-prep');
  const emitTo = vi.fn().mockResolvedValue(undefined);
  const acknowledgePreparation = vi.fn(async () => { expect(accepted).toBe(true); return 42; });
  const owner = createComposeWindowOwner({ open, emitTo, update: vi.fn(), close: vi.fn(), settings: { composeSize: async () => { await new Promise(r => { release = r; }); accepted = true; } }, acknowledgePreparation });
  const handoff = owner.detach({ id: 212, mode: 'reply', snapshot: snapshot() });
  await vi.waitFor(() => expect(open).toHaveBeenCalled()); const token = open.mock.calls[0][0].token;
  ready(owner, 212, token); owner.receive({ composeId: '212', token, requestId: 'init', type: 'initialized' }); await handoff;
  owner.receive({ composeId: '212', token, requestId: 'setting', type: 'settings', payload: { key: 'composeSize', value: {} } });
  owner.receive({ composeId: '212', token, requestId: 'prep', type: 'prepare-settings' });
  expect(owner.receive({ composeId: '212', token: 'old', requestId: 'stale', type: 'prepare-settings' })).toBe(false);
  await vi.waitFor(() => expect(release).toBeTypeOf('function')); expect(acknowledgePreparation).not.toHaveBeenCalled();
  release();
  await vi.waitFor(() => expect(emitTo).toHaveBeenCalledWith('compose-prep', 'compose-window-message', expect.objectContaining({ requestId: 'prep', type: 'ack', payload: 42 })));
  owner.recover(212);
});

it('pushes authoritative accounts and fences preparation ACK after child close', async () => {
  let release;
  const open = vi.fn().mockResolvedValue('compose-accounts'); const emitTo = vi.fn().mockResolvedValue(undefined);
  const owner = createComposeWindowOwner({ open, emitTo, update: vi.fn(), close: vi.fn(), acknowledgePreparation: () => new Promise(r => { release = r; }) });
  const handoff = owner.detach({ id: 213, mode: 'reply', snapshot: snapshot() });
  await vi.waitFor(() => expect(open).toHaveBeenCalled()); const token = open.mock.calls[0][0].token;
  ready(owner, 213, token); owner.receive({ composeId: '213', token, requestId: 'init', type: 'initialized' }); await handoff;
  owner.receive({ composeId: '213', token, requestId: 'prep', type: 'prepare-settings' });
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  const accounts = [{ id: 'replacement', email: 'current@example.test' }]; owner.pushAccounts(accounts, 'replacement');
  expect(emitTo).toHaveBeenCalledWith('compose-accounts', 'compose-window-message', expect.objectContaining({ type: 'accounts-changed', token, payload: { accounts, activeAccountId: 'replacement' } }));
  owner.recover(213); release(9); await Promise.resolve(); await Promise.resolve();
  expect(emitTo.mock.calls.some(([, , m]) => m.requestId === 'prep' && m.type === 'ack')).toBe(false);
});

describe('checked detached admission', () => {
  it('never queues or closes on a final invalid outcome', async () => {
    const open = vi.fn().mockResolvedValue('checked');
    const emitTo = vi.fn().mockResolvedValue();
    const queueSend = vi.fn();
    const remove = vi.fn();
    const account = { id: 'account', email: 'me@example.test' };
    const checkPreparation = vi.fn().mockResolvedValueOnce({ kind: 'ready', settingsVersion: 4, route: { delay: null } })
      .mockResolvedValueOnce({ kind: 'invalid', settingsVersion: 4, key: 'scheduled.picker.pastTime' });
    const owner = createComposeWindowOwner({ open, emitTo, update: vi.fn(), close: vi.fn(), remove, queueSend,
      acknowledgePreparation: async () => 4, checkPreparation, sendContext: () => ({ account, senderSettings: { displayName: 'Me' } }) });
    const handoff = owner.detach({ id: 99, mode: 'new', snapshot: snapshot() });
    await vi.waitFor(() => expect(open).toHaveBeenCalled());
    const token = open.mock.calls[0][0].token;
    const receive = (type, payload, requestId) => owner.receive({ composeId: '99', token, type, payload, requestId });
    receive('ready', null, 'ready'); receive('initialized', null, 'init'); await handoff;
    receive('prepare-settings', { purpose: 'send-check', attempt: 1, editorGeneration: 1, snapshot: snapshot(), authoredBodyText: 'Body', timeZone: 'UTC' }, 'check');
    await vi.waitFor(() => expect(emitTo).toHaveBeenCalledWith('checked', 'compose-window-message', expect.objectContaining({ requestId: 'check', type: 'ack' })));
    receive('send', { attempt: 1, editorGeneration: 1 }, 'send');
    await vi.waitFor(() => expect(emitTo).toHaveBeenCalledWith('checked', 'compose-window-message', expect.objectContaining({ requestId: 'send' })));
    expect(queueSend).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(emitTo.mock.calls.some(([, , m]) => m.type === 'accepted')).toBe(false);
  });
});

const checkedFixture = async (overrides = {}) => {
  const open = vi.fn().mockResolvedValue('checked-races');
  const emitTo = vi.fn().mockResolvedValue();
  const queueSend = vi.fn(); const remove = vi.fn(); const close = vi.fn(); const update = vi.fn();
  let context = { account: testAccount, senderSettings: { displayName: 'Me' }, remindAllowed: true };
  const checkPreparation = vi.fn().mockResolvedValue({ kind: 'ready', settingsVersion: 4, route: { delay: null } });
  const owner = createOwner({ open, emitTo, update, queueSend, remove, close, acknowledgePreparation: async () => 4,
    checkPreparation, sendContext: () => context, ...overrides });
  const handoff = owner.detach({ id: 400, mode: 'new', snapshot: snapshot() });
  await vi.waitFor(() => expect(open).toHaveBeenCalled()); const token = open.mock.calls[0][0].token;
  const receive = (type, payload, requestId = type) => owner.receive({ composeId: '400', token, type, payload, requestId });
  receive('ready'); receive('initialized'); await handoff;
  const prepare = async (extra = {}, requestId = 'check') => {
    receive('prepare-settings', { purpose: 'send-check', attempt: 1, editorGeneration: 1, snapshot: snapshot(), authoredBodyText: 'Body', timeZone: 'UTC', ...extra }, requestId);
    await vi.waitFor(() => expect(emitTo.mock.calls.some(([, , m]) => m.requestId === requestId)).toBe(true));
  };
  return { owner, receive, prepare, emitTo, checkPreparation, queueSend, remove, close, update,
    setContext: next => { context = next; }, context, token };
};

describe('detached final check authority', () => {
  it.each(['account deletion', 'account replacement', 'sender name', 'authority generation', 'child edit'])('refuses %s between check and admission', async change => {
    const f = await checkedFixture(); await f.prepare();
    if (change === 'account deletion') f.setContext({ ...f.context, account: undefined });
    if (change === 'account replacement') f.setContext({ ...f.context, account: { ...testAccount } });
    if (change === 'sender name') f.setContext({ ...f.context, senderSettings: { displayName: 'Changed' } });
    if (change === 'authority generation') f.owner.invalidateSendPreparation();
    if (change === 'child edit') f.receive('prepare-settings', { purpose: 'invalidate-send-check', editorGeneration: 2 }, 'edit');
    f.receive('send', { attempt: 1, editorGeneration: 1 });
    await vi.waitFor(() => expect(f.emitTo.mock.calls.some(([, , m]) => m.requestId === 'send')).toBe(true));
    expect(f.queueSend).not.toHaveBeenCalled(); expect(f.remove).not.toHaveBeenCalled();
  });
  it.each(['authority', 'edit', 'close'])('refuses a late final ready after %s', async change => {
    const f = await checkedFixture(); await f.prepare();
    let finish;
    f.checkPreparation.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    f.receive('send', { attempt: 1, editorGeneration: 1 });
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    if (change === 'authority') f.owner.invalidateSendPreparation();
    if (change === 'edit') f.receive('prepare-settings', { purpose: 'invalidate-send-check', editorGeneration: 2 }, 'edit');
    if (change === 'close') f.owner.recover(400);
    finish({ kind: 'ready', route: { delay: null } });
    await vi.waitFor(() => expect(f.queueSend).not.toHaveBeenCalled());
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(f.queueSend).not.toHaveBeenCalled(); expect(f.remove).not.toHaveBeenCalled();
  });
  it('queues the complete source once and closes on lost accepted ACK', async () => {
    const f = await checkedFixture(); await f.prepare();
    f.emitTo.mockImplementation(async (_label, _channel, message) => { if (message.type === 'accepted') throw new Error('ACK lost'); });
    f.receive('send', { attempt: 1, editorGeneration: 1 });
    f.receive('send', { attempt: 1, editorGeneration: 1 }, 'duplicate');
    await vi.waitFor(() => expect(f.close).toHaveBeenCalledWith('checked-races'));
    expect(f.queueSend).toHaveBeenCalledTimes(1);
    expect(f.queueSend.mock.calls[0][0]).toMatchObject({ body: '<p>Body</p>', bcc: 'bcc@example.test', _quotedHtml: '<p>part</p>', _composeDelay: null });
    expect(f.queueSend.mock.calls[0][4]).toMatchObject({ account: testAccount, settings: { displayName: 'Me' } });
    expect(f.remove).toHaveBeenCalledTimes(1);
  });
  it('never accepts snapshot or route replacement at admission', async () => {
    const f = await checkedFixture(); await f.prepare();
    f.receive('send', { attempt: 1, editorGeneration: 1, snapshot: snapshot('forged') });
    await vi.waitFor(() => expect(f.emitTo.mock.calls.some(([, , m]) => m.requestId === 'send')).toBe(true));
    expect(f.queueSend).not.toHaveBeenCalled();
  });
  it('confirms only the stored source and reruns every policy check', async () => {
    const f = await checkedFixture(); f.checkPreparation.mockResolvedValueOnce({ kind: 'confirm_attachment', settingsVersion: 4 });
    await f.prepare();
    f.receive('prepare-settings', { purpose: 'send-check', attempt: 2, editorGeneration: 1, confirmationAttempt: 1 }, 'confirm');
    await vi.waitFor(() => expect(f.checkPreparation).toHaveBeenCalledTimes(2));
    expect(f.checkPreparation.mock.calls[1][0]).toMatchObject({ snapshot: snapshot(), sendAnyway: true, settingsVersion: 4 });
    f.receive('send', { attempt: 2, editorGeneration: 1 });
    await vi.waitFor(() => expect(f.queueSend).toHaveBeenCalledTimes(1));
    expect(f.checkPreparation).toHaveBeenCalledTimes(3);
  });
  it('does not upgrade final settings authority on conflict', async () => {
    const acknowledgePreparation = vi.fn(async () => 4);
    const f = await checkedFixture({ acknowledgePreparation }); await f.prepare();
    f.checkPreparation.mockRejectedValueOnce(new Error('errors.settingsConflict'));
    f.receive('send', { attempt: 1, editorGeneration: 1 });
    await vi.waitFor(() => expect(f.emitTo.mock.calls.some(([, , m]) => m.requestId === 'send' && m.type === 'error')).toBe(true));
    expect(acknowledgePreparation).toHaveBeenCalledTimes(1); expect(f.queueSend).not.toHaveBeenCalled();
  });
  it.each(['invalid', 'confirm_attachment'])('returns ordinary final %s ACK without admission', async kind => {
    const f = await checkedFixture(); await f.prepare();
    f.checkPreparation.mockResolvedValueOnce({ kind, key: 'scheduled.picker.pastTime', settingsVersion: 4 });
    f.receive('send', { attempt: 1, editorGeneration: 1 });
    await vi.waitFor(() => expect(f.emitTo).toHaveBeenCalledWith('checked-races', 'compose-window-message', expect.objectContaining({ requestId: 'send', type: 'ack', payload: expect.objectContaining({ attempt: 1, outcome: expect.objectContaining({ kind }) }) })));
    expect(f.queueSend).not.toHaveBeenCalled(); expect(f.remove).not.toHaveBeenCalled();
  });
});
