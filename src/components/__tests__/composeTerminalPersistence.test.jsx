// @vitest-environment jsdom
// Real settings cache/load/write/flush path; only native IO acknowledgements are controlled.
import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const read = deferred();
const writes = [];
const invoke = vi.fn((command, args) => {
  if (command === 'daemon_rpc' && args.method === 'settings.get') return read.promise;
  if (command === 'daemon_rpc' && args.method === 'settings.replace') { const ack = deferred(); writes.push({ values: args.params.values, ack }); return ack.promise; }
  return Promise.resolve();
});
window.__TAURI__ = { core: { invoke } };
const { safeStorage, flushSafeStorage, setSafeStorageWriteEnabled } = await import('../../stores/safeStorage');
const { useComposeSessionHydration, loadComposeSession, saveComposeSession } = await import('../../services/composeSession');
function Harness({ controls, discard }) {
  const [windows, setWindows] = React.useState([{ id: 1, initialData: { _draftId: 'fresh', _draftRevision: 1, body: 'fresh complete' } }]);
  const idRef = React.useRef(10);
  const owner = useComposeSessionHydration({ windows, setWindows, idRef, loader: loadComposeSession, persist: saveComposeSession, flush: flushSafeStorage, discard });
  controls.current = { ...owner, windows, add: () => setWindows(prev => [...prev, { id: 2, initialData: { _draftId: 'ongoing', body: 'ongoing words' } }]) };
  return null;
}
afterEach(() => { cleanup(); setSafeStorageWriteEnabled(false); vi.useRealTimers(); });
it('acknowledges early unknown cleanup only after the merged array is really written and retains failed flush ownership', async () => {
  vi.useFakeTimers(); const controls = { current: null }; const discard = vi.fn().mockRejectedValue(Error('cleanup ACK lost'));
  render(<Harness {...{ controls, discard }} />); await act(async () => {});
  let operation, settled = false;
  await act(async () => { operation = controls.current.terminalCleanup({ _draftId: 'fresh', _draftRevision: 1, body: 'fresh complete' }, 'discard', 1).then(value => { settled = true; return value; }); });
  await act(async () => { controls.current.add(); });
  expect(settled).toBe(false); expect(writes).toHaveLength(0);
  const saved = [{ id: 70, initialData: { _draftId: 'stored', body: 'stored words' } }, { id: 71, initialData: { _draftId: 'unrelated', body: 'unrelated words' } }];
  await act(async () => { read.resolve({ version: 1, values: { 'mailvault-compose-session': saved, untouched: { saved: true } } }); });
  expect(settled).toBe(false);
  expect(writes).toHaveLength(1);
  const ids = writes[0].values['mailvault-compose-session'].map(window => window.initialData._draftId).sort();
  expect(ids).toEqual(['fresh', 'ongoing', 'stored', 'unrelated']);
  let result;
  await act(async () => { writes[0].ack.reject('errors.settingsWriteFailed'); result = await operation; });
  expect(result.persistenceFailed).toBe(true);
  const owner = controls.current.windows.find(window => window.snapshot?._draftId === 'fresh');
  expect(owner.snapshot).toMatchObject({ _draftCleanupState: 'unknown', _draftCleanupPersistError: true });
  let retry, retried = false;
  await act(async () => { retry = controls.current.retryCleanup(owner.id).then(value => { retried = true; return value; }); });
  expect(retried).toBe(false); expect(writes).toHaveLength(2);
  await act(async () => { writes[1].ack.resolve({ version: 2 }); await retry; });
  expect(retried).toBe(true);
  expect(JSON.parse(await safeStorage.getItem('mailvault-compose-session')).map(window => window.initialData._draftId).sort()).toEqual(['fresh', 'ongoing', 'stored', 'unrelated']);
});
