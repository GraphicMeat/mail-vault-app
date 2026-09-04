import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

vi.mock('../../services/api', () => ({
  sendNotification: vi.fn(() => Promise.resolve()),
}));

const { sendNotification } = await import('../../services/api');
const { useFocusStore, useFocusClock, notify, remainingMs, formatRemaining } = await import('../focusStore');

const T0 = 1_700_000_000_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  useFocusStore.getState().abandon();
  useFocusStore.setState({ held: [] });
  useFocusClock.setState({ now: 0 });
  vi.clearAllMocks();
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
