import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFileSync as captureWriteFileSync } from 'node:fs';

// safeStorage is the persist backend for every store this file pulls in.
// `mem` is hoisted so a case can seed a persisted session before rehydrating.
const mem = vi.hoisted(() => {
  const store = {};
  return { store, setItem: vi.fn((key, val) => { store[key] = val; }) };
});
vi.mock('../safeStorage', () => ({
  safeStorage: {
    getItem: (key) => mem.store[key] ?? null,
    setItem: mem.setItem,
    removeItem: (key) => { delete mem.store[key]; },
  },
}));

/** Writes of OUR key only — neighbouring stores share this backend. */
const focusWrites = () => mem.setItem.mock.calls.filter(c => c[0] === 'mailvault-focus').length;

// The daemon's answer for a mail banner (`notify.decide`); a case sets its own.
const DELIVERED = { deliver: true, reason: 'delivered-default' };
vi.mock('../../services/api', () => ({
  sendNotification: vi.fn(() => Promise.resolve()),
  notifyDecision: vi.fn(),
}));

const { sendNotification, notifyDecision } = await import('../../services/api');
const { usePrivacyStore } = await import('../privacyStore');
const {
  useFocusStore, useFocusClock, notify, remainingMs, formatRemaining,
  getNotificationDecisions, clearNotificationDecisions, FOCUS_SCENES,
} = await import('../focusStore');

const T0 = 1_700_000_000_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  useFocusStore.getState().abandon();
  useFocusStore.setState({ held: [] });
  useFocusClock.setState({ now: 0 });
  clearNotificationDecisions();
  vi.clearAllMocks();
  notifyDecision.mockImplementation(async ({ focusHeld }) => (focusHeld ? { deliver: false, reason: 'focus-hold' } : DELIVERED));
});

afterEach(() => {
  useFocusStore.getState().abandon();
  vi.useRealTimers();
});

describe('start', () => {
  it('sets the end stamp and the remembered preset', () => {
    useFocusStore.getState().start(25);
    const s = useFocusStore.getState();
    expect(s.endsAt).toBe(T0 + 1_500_000);
    expect(s.durationMin).toBe(25);
  });

  // Nothing here presumes the four preset buttons; the dialog also takes a
  // typed number, and 7 is not one of them.
  it('takes any number of minutes, not just a preset', () => {
    useFocusStore.getState().start(7);
    const s = useFocusStore.getState();
    expect(s.endsAt).toBe(T0 + 7 * 60_000);
    expect(s.durationMin).toBe(7);
  });
});

describe('formatRemaining', () => {
  it('rounds seconds up so the last second reads 00:01, never 00:00', () => {
    expect(formatRemaining(61_000)).toBe('01:01');
    expect(formatRemaining(60_500)).toBe('01:01');
    expect(formatRemaining(0)).toBe('00:00');
    expect(formatRemaining(3_600_000)).toBe('60:00');
  });
});

describe('remainingMs', () => {
  it('is zero with no session and never negative', () => {
    expect(remainingMs({ endsAt: null, now: T0 })).toBe(0);
    expect(remainingMs({ endsAt: T0, now: T0 + 5_000 })).toBe(0);
    expect(remainingMs({ endsAt: T0 + 5_000, now: T0 })).toBe(5_000);
  });
});

describe('notify', () => {
  it('sends straight through with no session running', async () => {
    await notify('Title', 'Body');
    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(sendNotification).toHaveBeenCalledWith('Title', 'Body');
    expect(useFocusStore.getState().held).toEqual([]);
  });

  it('holds instead of sending while a session runs', async () => {
    useFocusStore.getState().start(25);
    await notify('Title', 'Body');
    expect(sendNotification).not.toHaveBeenCalled();
    expect(useFocusStore.getState().held).toEqual([{ title: 'Title', body: 'Body' }]);
  });

  it('resolves even when the native call rejects', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    sendNotification.mockRejectedValueOnce(new Error('no notification permission'));
    await expect(notify('Title', 'Body')).resolves.toBeUndefined();
    err.mockRestore();
  });
});

describe('the ticker', () => {
  it('advances now, then finishes and flushes what it held', async () => {
    useFocusStore.getState().start(1);
    await notify('First', 'one');
    await notify('Second', 'two');

    await vi.advanceTimersByTimeAsync(59_000);
    expect(useFocusClock.getState().now).toBe(T0 + 59_000);
    expect(useFocusStore.getState().endsAt).toBe(T0 + 60_000);
    expect(sendNotification).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(useFocusStore.getState().endsAt).toBe(null);
    expect(useFocusStore.getState().held).toEqual([]);

    const titles = sendNotification.mock.calls.map(c => c[0]);
    expect(titles).toEqual(['Focus session complete', 'First', 'Second']);
    expect(sendNotification.mock.calls[0][1]).toBe('1 minute done. MailVault is yours again.');
  });

  // "on end a notification should fire" — the session state is cleared BEFORE
  // the done notification, so the banner announcing the end is not swallowed by
  // the session it announces. It goes out first, held work behind it.
  it('sends the end notification itself rather than holding it', async () => {
    useFocusStore.getState().start(1);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(sendNotification.mock.calls[0]).toEqual([
      'Focus session complete',
      '1 minute done. MailVault is yours again.',
    ]);
    expect(useFocusStore.getState().held).toEqual([]);
  });

  it('summarises rather than firing a burst when more than three were held', async () => {
    useFocusStore.getState().start(1);
    for (const n of [1, 2, 3, 4]) await notify(`N${n}`, `b${n}`);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(sendNotification).toHaveBeenCalledTimes(2);
    expect(sendNotification.mock.calls[0][0]).toBe('Focus session complete');
    expect(sendNotification.mock.calls[1][0]).toBe('While you were focused');
    expect(sendNotification.mock.calls[1][1]).toBe('4 notifications arrived while MailVault was locked.');
  });
});

describe('a held new-mail banner', () => {
  // Released after the session, a banner that clicks to nothing is a banner
  // that lost the one thing the user would click it for.
  it('keeps the email it opens', async () => {
    const target = { accountId: 'a1', mailbox: 'INBOX', uid: 7 };
    useFocusStore.getState().start(1);
    await notify('Ada', 'Hello', undefined, target);

    useFocusStore.getState().abandon();
    await vi.advanceTimersByTimeAsync(0);

    expect(sendNotification.mock.calls).toEqual([['Ada', 'Hello', undefined, target]]);
  });
});

describe('the persisted file', () => {
  // The clock ticks once a second. If it went through `persist`, a 25-minute
  // session would rewrite the whole settings file ~1500 times.
  it('is not rewritten by the ticker', async () => {
    useFocusStore.getState().start(1);
    const before = focusWrites();

    await vi.advanceTimersByTimeAsync(5_000);

    expect(focusWrites()).toBe(before);
    expect(useFocusClock.getState().now).toBe(T0 + 5_000);
  });
});

describe('abandon', () => {
  it('clears the session and flushes held work without congratulating anyone', async () => {
    useFocusStore.getState().start(25);
    await notify('Held', 'body');

    useFocusStore.getState().abandon();
    await vi.advanceTimersByTimeAsync(0);

    const s = useFocusStore.getState();
    expect(s.endsAt).toBe(null);
    expect(s.held).toEqual([]);
    expect(sendNotification.mock.calls.map(c => c[0])).toEqual(['Held']);
  });
});

describe('rehydration', () => {
  it('resumes a session that outlived the app', async () => {
    mem.store['mailvault-focus'] = JSON.stringify({
      state: { endsAt: T0 + 30_000, durationMin: 25 },
      version: 0,
    });
    await useFocusStore.persist.rehydrate();
    expect(useFocusStore.getState().endsAt).toBe(T0 + 30_000);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(useFocusStore.getState().endsAt).toBe(null);
    delete mem.store['mailvault-focus'];
  });

  it('clears a session that expired while the app was shut, silently', async () => {
    mem.store['mailvault-focus'] = JSON.stringify({
      state: { endsAt: T0 - 30_000, durationMin: 25 },
      version: 0,
    });
    await useFocusStore.persist.rehydrate();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(useFocusStore.getState().endsAt).toBe(null);
    expect(sendNotification).not.toHaveBeenCalled();
    delete mem.store['mailvault-focus'];
  });
});

describe('notify() with a mail-arrival context', () => {
  // A caller that hands notify() no ctx at all (billing, backup, focus's own
  // banners) is untouched by the policy — that's the whole point of it being
  // an optional 5th argument.
  it('delivers as before when no policy context is given', async () => {
    await notify('Backup complete', 'Saved 200 messages');
    expect(sendNotification).toHaveBeenCalledWith('Backup complete', 'Saved 200 messages');
    expect(getNotificationDecisions()).toEqual([]);
  });

  it('suppresses a notification the policy rejects, and never calls sendNotification for it', async () => {
    notifyDecision.mockResolvedValue({ deliver: false, reason: 'account-muted' });
    const ctx = { accountId: 'a1', folder: 'INBOX', from: 'x@y.com', viewIds: [] };

    await notify('Rokas', 'Hello', undefined, undefined, ctx);

    expect(notifyDecision).toHaveBeenCalledWith({ ...ctx, focusHeld: false });
    expect(sendNotification).not.toHaveBeenCalled();
    const log = getNotificationDecisions();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ subject: 'Rokas', from: 'x@y.com', deliver: false, reason: 'account-muted' });
    expect(typeof log[0].ts).toBe('number');
  });

  it('records a delivered decision too, and still calls sendNotification', async () => {
    const ctx = { accountId: 'a1', folder: 'INBOX', from: 'x@y.com', viewIds: [] };

    await notify('Rokas', 'Hello', undefined, undefined, ctx);

    expect(sendNotification).toHaveBeenCalledWith('Rokas', 'Hello');
    const log = getNotificationDecisions();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ deliver: true, reason: 'delivered-default' });
  });

  it('a running Focus session still holds a policy-governed notification for later', async () => {
    useFocusStore.getState().start(25);
    const ctx = { accountId: 'a1', folder: 'INBOX', from: 'x@y.com', viewIds: [] };

    await notify('Rokas', 'Hello', undefined, undefined, ctx);

    expect(notifyDecision).toHaveBeenCalledWith({ ...ctx, focusHeld: true });
    expect(sendNotification).not.toHaveBeenCalled();
    expect(useFocusStore.getState().held).toHaveLength(1);
    expect(getNotificationDecisions()[0]).toMatchObject({ deliver: false, reason: 'focus-hold' });
  });

  it('a banner held by a session that ended while the daemon answered is shown now', async () => {
    useFocusStore.getState().start(25);
    notifyDecision.mockImplementation(async () => {
      useFocusStore.getState().abandon();
      return { deliver: false, reason: 'focus-hold' };
    });
    const ctx = { accountId: 'a1', folder: 'INBOX', from: 'x@y.com', viewIds: [] };

    await notify('Rokas', 'Hello', undefined, { accountId: 'a1', mailbox: 'INBOX', uid: 3 }, ctx);

    expect(sendNotification).toHaveBeenCalledWith('Rokas', 'Hello', undefined, { accountId: 'a1', mailbox: 'INBOX', uid: 3 });
    expect(useFocusStore.getState().held).toEqual([]);
  });

  it('a daemon that cannot answer lets the banner out, logged as such', async () => {
    const ctx = { accountId: 'a1', folder: 'INBOX', from: 'x@y.com', viewIds: [] };
    for (const failure of [() => Promise.reject(new Error('DAEMON_OFFLINE')), () => Promise.resolve(null), () => { throw new Error('sync'); }]) {
      notifyDecision.mockImplementationOnce(failure);
      await expect(notify('Rokas', 'Hello', undefined, undefined, ctx)).resolves.toBeUndefined();
    }
    expect(sendNotification).toHaveBeenCalledTimes(3);
    expect(getNotificationDecisions().map(d => [d.deliver, d.reason])).toEqual(Array(3).fill([true, 'policy-unavailable']));
  });

  it('only mail banners ask the daemon', async () => {
    await notify('Backup complete', 'Saved 200 messages');
    expect(notifyDecision).not.toHaveBeenCalled();
  });

  it('keeps only the last 200 decisions', async () => {
    const ctx = { accountId: 'a1', folder: 'INBOX', from: 'x@y.com', viewIds: [] };
    for (let i = 0; i < 205; i++) await notify(`Subject ${i}`, 'body', undefined, undefined, ctx);
    const log = getNotificationDecisions();
    expect(log).toHaveLength(200);
    expect(log[0].subject).toBe('Subject 5');
    expect(log[199].subject).toBe('Subject 204');
  });
});

describe('scene', () => {
  afterEach(() => {
    useFocusStore.setState({ scene: 'countryside' });
    delete mem.store['mailvault-focus'];
  });

  it('keeps the last scene when a session starts without one', () => {
    useFocusStore.setState({ scene: 'sea' });
    useFocusStore.getState().start(25);
    expect(useFocusStore.getState().scene).toBe('sea');
  });

  it('remembers the scene a session starts on, the plain lock included', () => {
    useFocusStore.getState().start(25, 'town');
    expect(useFocusStore.getState().scene).toBe('town');
    useFocusStore.getState().abandon();
    useFocusStore.getState().start(25, 'none');
    expect(useFocusStore.getState().scene).toBe('none');
  });

  it('ignores a scene it does not know', () => {
    useFocusStore.getState().start(25, 'volcano');
    expect(useFocusStore.getState().scene).toBe('countryside');
  });

  it('writes the scene to the persisted file and reads it back after a relaunch', async () => {
    useFocusStore.getState().start(25, 'sea');
    const saved = mem.store['mailvault-focus'];
    expect(JSON.parse(saved).state.scene).toBe('sea');
    // Forget it in memory (persist writes that too), then relaunch on the saved file.
    useFocusStore.setState({ scene: 'countryside' });
    mem.store['mailvault-focus'] = saved;
    await useFocusStore.persist.rehydrate();
    expect(useFocusStore.getState().scene).toBe('sea');
  });

  it('reads a scene saved by a newer build as the default rather than a blank lock', async () => {
    mem.store['mailvault-focus'] = JSON.stringify({ state: { durationMin: 25, scene: 'volcano', endsAt: null }, version: 0 });
    await useFocusStore.persist.rehydrate();
    expect(useFocusStore.getState().scene).toBe('countryside');
  });

  it('has a loader for every scene it offers, and offers every scene there is', async () => {
    const { SCENE_LOADERS } = await import('../../components/focus/scenes/index.js');
    expect(Object.keys(SCENE_LOADERS).sort()).toEqual([...FOCUS_SCENES].sort());
  });
});

// Conditional S4 oracle capture through the real old Focus chokepoint. The
// policy answers below are external inputs, not copied notification decisions.
it.skipIf(!process.env.W4S4_ORACLE_FD_OUT)('captures F01-F05 and D01-D03 old Focus and policy effects', async () => {
  const target = process.env.W4S4_ORACLE_FD_OUT;
  if (!target) throw new Error('W4S4_ORACLE_FD_OUT is required');
  const encode = value => value === undefined ? { $undefined: true }
    : Array.isArray(value) ? value.map(encode)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encode(item)]))
      : value;
  const ctx = { accountId: 'a1', folder: 'INBOX', from: 'sender@outside.test', viewIds: [] };
  const reset = () => {
    useFocusStore.getState().abandon();
    useFocusStore.setState({ held: [] });
    clearNotificationDecisions();
    vi.clearAllMocks();
    notifyDecision.mockImplementation(async ({ focusHeld }) => focusHeld
      ? { deliver: false, reason: 'focus-hold' } : DELIVERED);
  };
  const effects = () => encode({ osCalls: sendNotification.mock.calls,
    policyCalls: notifyDecision.mock.calls, decisions: getNotificationDecisions(),
    held: useFocusStore.getState().held });
  const cases = [];
  reset();
  await notify('Sender', 'Subject', undefined, { accountId: 'a1', mailbox: 'INBOX', uid: 7 }, ctx);
  cases.push({ id: 'F01', input: { focus: false }, output: effects() });
  reset();
  useFocusStore.getState().start(25);
  await notify('Sender', 'Subject', undefined, { accountId: 'a1', mailbox: 'INBOX', uid: 7 }, ctx);
  cases.push({ id: 'F02', input: { focus: true }, output: effects() });
  const f03 = [];
  reset();
  let resolveBegin;
  notifyDecision.mockReturnValueOnce(new Promise(done => { resolveBegin = done; }));
  const began = notify('Sender', 'Subject', undefined, undefined, ctx);
  useFocusStore.getState().start(25);
  resolveBegin(DELIVERED);
  await began;
  f03.push({ input: { transition: 'begin-while-awaiting' }, output: effects() });
  reset();
  useFocusStore.getState().start(25);
  let resolveEnd;
  notifyDecision.mockReturnValueOnce(new Promise(done => { resolveEnd = done; }));
  const ended = notify('Sender', 'Subject', undefined, undefined, ctx);
  useFocusStore.getState().abandon();
  resolveEnd({ deliver: false, reason: 'focus-hold' });
  await ended;
  f03.push({ input: { transition: 'end-while-awaiting' }, output: effects() });
  cases.push({ id: 'F03', samples: f03 });
  const f04 = [];
  for (const count of [1, 3]) {
    reset();
    useFocusStore.getState().start(25);
    for (let n = 1; n <= count; n++) await notify(`Sender ${n}`, `Subject ${n}`, undefined,
      { accountId: 'a1', mailbox: 'INBOX', uid: n }, ctx);
    useFocusStore.getState().abandon();
    await vi.advanceTimersByTimeAsync(0);
    f04.push({ input: { heldCount: count }, output: effects() });
  }
  cases.push({ id: 'F04', samples: f04 });
  reset();
  useFocusStore.getState().start(25);
  for (let n = 1; n <= 4; n++) await notify(`Sender ${n}`, `Subject ${n}`, undefined,
    { accountId: 'a1', mailbox: 'INBOX', uid: n }, ctx);
  useFocusStore.getState().abandon();
  await vi.advanceTimersByTimeAsync(0);
  cases.push({ id: 'F05', input: { heldCount: 4 }, output: effects() });
  const d01 = [];
  for (const decision of [DELIVERED, { deliver: false, reason: 'account-muted' }]) {
    reset();
    notifyDecision.mockResolvedValueOnce(decision);
    await notify('Sender', 'Subject', undefined, undefined, ctx);
    d01.push({ input: { decision }, output: effects() });
  }
  cases.push({ id: 'D01', samples: d01 });
  const d02 = [];
  for (const failure of ['reject', 'malformed']) {
    reset();
    if (failure === 'reject') notifyDecision.mockRejectedValueOnce(new Error('policy-offline'));
    else notifyDecision.mockResolvedValueOnce(null);
    await notify('Sender', 'Subject', undefined, undefined, ctx);
    d02.push({ input: { failure }, output: effects() });
  }
  cases.push({ id: 'D02', samples: d02 });
  reset();
  for (let n = 0; n < 205; n++) await notify(`Sender ${n}`, 'Subject', undefined, undefined, ctx);
  cases.push({ id: 'D03', input: { count: 205 }, output: {
    decisionLog: encode(getNotificationDecisions()), logLength: getNotificationDecisions().length,
    osCount: sendNotification.mock.calls.length, policyCount: notifyDecision.mock.calls.length } });
  captureWriteFileSync(target, JSON.stringify({ kind: 's4-legacy-focus-policy', cases }, null, 2) + '\n');
});

it.skipIf(!process.env.W4S4_ORACLE_PRIVACY_OUT)('captures F07-F09 old privacy timing and OS-target effects', async () => {
  const target = process.env.W4S4_ORACLE_PRIVACY_OUT;
  if (!target) throw new Error('W4S4_ORACLE_PRIVACY_OUT is required');
  const encode = value => value === undefined ? { $undefined: true }
    : Array.isArray(value) ? value.map(encode)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encode(item)]))
      : value;
  const ctx = { accountId: 'a1', folder: 'INBOX', from: 'sender@outside.test', viewIds: [] };
  const msgTarget = { accountId: 'a1', mailbox: 'INBOX', uid: 7, code: '123456' };
  const reset = () => {
    useFocusStore.getState().abandon();
    useFocusStore.setState({ held: [] });
    usePrivacyStore.setState({ enabled: false });
    clearNotificationDecisions();
    vi.clearAllMocks();
    notifyDecision.mockReset().mockResolvedValue(DELIVERED);
  };
  const effects = () => encode({ osCalls: sendNotification.mock.calls,
    policyCalls: notifyDecision.mock.calls, decisions: getNotificationDecisions(),
    held: useFocusStore.getState().held,
    privacyEnabled: usePrivacyStore.getState().enabled,
    privacyHydrated: usePrivacyStore.persist.hasHydrated() });
  const cases = [];
  try {
    reset();
    useFocusStore.getState().start(25);
    await notify('Sender', '123456\nSubject', undefined, msgTarget, ctx);
    const heldBeforeToggle = effects();
    usePrivacyStore.setState({ enabled: true });
    useFocusStore.getState().abandon();
    await vi.advanceTimersByTimeAsync(0);
    cases.push({ id: 'F07', input: { transition: 'privacy-on-while-held' },
      output: { heldBeforeToggle, afterRelease: effects() } });
    const f08 = [];
    for (const [before, after] of [[false, true], [true, false]]) {
      reset();
      usePrivacyStore.setState({ enabled: before });
      let release;
      notifyDecision.mockReturnValueOnce(new Promise(done => { release = done; }));
      const pending = notify('Sender', '123456\nSubject', undefined, msgTarget, ctx);
      usePrivacyStore.setState({ enabled: after });
      release(DELIVERED);
      await pending;
      f08.push({ input: { privacyBefore: before, privacyAfter: after }, output: effects() });
    }
    cases.push({ id: 'F08', samples: f08 });
    reset();
    usePrivacyStore.setState({ enabled: true });
    await notify('Sender', '123456\nSubject', undefined, msgTarget, ctx);
    const mail = effects();
    await notify('Backup for Sender 123456', 'Saved Sender 123456');
    cases.push({ id: 'F09', input: { privacy: true, mailTarget: msgTarget },
      output: { mail, mailThenGeneric: effects() } });
    captureWriteFileSync(target, JSON.stringify({ kind: 's4-legacy-privacy-timing', cases }, null, 2) + '\n');
  } finally {
    useFocusStore.getState().abandon();
    usePrivacyStore.setState({ enabled: false });
  }
});

it.skipIf(!process.env.W4S4_ORACLE_F06_OUT)('captures F06 old privacy enabled, disabled, and unhydrated mail effects', async () => {
  const target = process.env.W4S4_ORACLE_F06_OUT;
  if (!target) throw new Error('W4S4_ORACLE_F06_OUT is required');
  const encode = value => value === undefined ? { $undefined: true }
    : Array.isArray(value) ? value.map(encode)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encode(item)]))
      : value;
  const ctx = { accountId: 'a1', folder: 'INBOX', from: 'sender@outside.test', viewIds: [] };
  const targetMessage = { accountId: 'a1', mailbox: 'INBOX', uid: 7, code: '123456' };
  const cases = [];
  const samples = [];
  try {
    for (const [mode, enabled, hydrated] of [
      ['off', false, true], ['on', true, true], ['unhydrated', false, false],
    ]) {
      useFocusStore.getState().abandon();
      useFocusStore.setState({ held: [] });
      usePrivacyStore.setState({ enabled });
      clearNotificationDecisions();
      vi.clearAllMocks();
      notifyDecision.mockReset().mockResolvedValue(DELIVERED);
      const hydration = vi.spyOn(usePrivacyStore.persist, 'hasHydrated').mockReturnValue(hydrated);
      try {
        await notify('Sender 123456', '123456\nSubject', 'Ping', targetMessage, ctx);
        samples.push({ input: { mode, enabled, hydrated }, output: encode({
          osCalls: sendNotification.mock.calls,
          policyCalls: notifyDecision.mock.calls,
          decisions: getNotificationDecisions(),
          held: useFocusStore.getState().held,
          privacyEnabled: usePrivacyStore.getState().enabled,
          privacyHydrated: usePrivacyStore.persist.hasHydrated(),
        }) });
      } finally { hydration.mockRestore(); }
    }
    cases.push({ id: 'F06', samples });
    captureWriteFileSync(target, JSON.stringify({ kind: 's4-legacy-privacy-hydration', cases }, null, 2) + '\n');
  } finally {
    useFocusStore.getState().abandon();
    usePrivacyStore.setState({ enabled: false });
  }
});

// S4 behavioral RED: the native policy answer enters the existing Focus/OS
// chokepoint and must never call the public notify.decide route again.
it('W4S4 prepared native mail delivery uses Focus without a second policy decision', async () => {
  usePrivacyStore.setState({ enabled: false });
  const hydration = vi.spyOn(usePrivacyStore.persist, 'hasHydrated').mockReturnValue(true);
  try {
    const ctx = { accountId: 'a1', folder: 'INBOX', from: 'new@example.test', viewIds: [] };
    const target = { accountId: 'a1', mailbox: 'INBOX', uid: 2 };
    const prepared = { deliver: true, reason: 'delivered-default' };
    await notify('New Sender', 'A real new subject', 'Ping', target, ctx, prepared);
    if (notifyDecision.mock.calls.length !== 0) {
      throw new Error('W4S4_FOCUS_PREDECIDED_RED: prepared native notice called notify.decide again');
    }
    expect(sendNotification).toHaveBeenCalledWith('New Sender', 'A real new subject', 'Ping', target);
    expect(getNotificationDecisions()).toHaveLength(1);
    expect(getNotificationDecisions()[0]).toMatchObject({ deliver: true, reason: 'delivered-default' });
  } finally { hydration.mockRestore(); }
});
