// @vitest-environment jsdom
import { it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
const send = vi.hoisted(() => vi.fn(async () => ({ accepted: true })));
const detach = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));
vi.mock('../../services/transport', () => ({ send }));
vi.mock('../../services/backupScheduler', () => ({ backupScheduler: { observe: () => detach } }));
vi.mock('../../stores/mailStore', () => ({ useMailStore: { getState: () => ({ loading: true }), subscribe: () => () => {} } }));
import { useBackupScheduler } from '../useBackupScheduler';
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1792929600000); send.mockClear(); detach.mockClear(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });
it('publishes measured hidden and real-sleep gaps without deciding sleep', async () => {
  renderHook(() => useBackupScheduler()); await flush();
  vi.setSystemTime(Date.now() + 60000); vi.advanceTimersByTime(15000); await flush();
  expect(send.mock.calls.at(-1)[1].heartbeatGap).toBe(75000);
  vi.setSystemTime(Date.now() + 136000); vi.advanceTimersByTime(15000); await flush();
  expect(send.mock.calls.at(-1)[1].heartbeatGap).toBe(151000);
  expect(send.mock.calls.every(([method]) => method === 'backup.context')).toBe(true);
});
it('retires its exact session and never wakes or stops work after unmount', async () => {
  const { unmount } = renderHook(() => useBackupScheduler()); await flush();
  const attach = send.mock.calls[0][1];
  vi.setSystemTime(Date.now() + 151000); vi.advanceTimersByTime(15000); unmount(); await flush();
  expect(send.mock.calls.at(-1)[1]).toEqual({ surfaceId: attach.surfaceId, sessionId: attach.sessionId, sequence: 3, kind: 'retire' });
  const count = send.mock.calls.length; vi.advanceTimersByTime(300000); await flush();
  expect(send).toHaveBeenCalledTimes(count); expect(detach).toHaveBeenCalledTimes(1);
});
it('publishes child loading independently and uses fresh mount identities', async () => {
  const first = renderHook(() => useBackupScheduler({ main: false })); await flush();
  const attach = send.mock.calls[0][1]; expect(attach.loading).toBe(false);
  first.unmount(); renderHook(() => useBackupScheduler()); await flush();
  const last = send.mock.calls.at(-1)[1]; expect(last.loading).toBe(true); expect(last.sessionId).not.toBe(attach.sessionId);
});
it.each([['keydown','click',500],['mousemove','mousemove',4000]])('preserves the first %s timestamp within its throttle', async (first, second, gap) => {
  renderHook(() => useBackupScheduler()); await flush();
  document.dispatchEvent(new Event(first)); await flush(); const at = send.mock.calls.at(-1)[1].lastActivityAt;
  vi.advanceTimersByTime(gap); document.dispatchEvent(new Event(second)); await flush();
  expect(send.mock.calls.at(-1)[1].lastActivityAt).toBe(at);
});
it('reattaches after an initial native-channel failure instead of publishing orphan updates forever', async () => {
  send.mockRejectedValueOnce(new Error('errors.settingsNotLoaded'));
  renderHook(() => useBackupScheduler()); await flush();
  vi.advanceTimersByTime(15000); await flush();
  expect(send.mock.calls.at(-1)[1].kind).toBe('attach');
});
