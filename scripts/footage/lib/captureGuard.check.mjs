import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCaptureGuard, waitForCaptureGuard } from './captureGuard.mjs';

const idle = {
  processes: [{ pid: 10, ppid: 1, command: 'tauri-wd --port 4444' },
    { pid: 11, ppid: 1, command: '/deleted-clone/target/debug/mock-imap-server' }],
  listeners: [{ pid: 10, port: 4444, address: '*:4444' }, { pid: 11, port: 52123, address: '127.0.0.1:52123' }],
  globalRunnerHeld: true,
};
const isolated = { allowIdleForeign: true, driverPort: 4468, root: '/capture' };

test('default refuses even idle infrastructure; opt-in preserves PID and port evidence', () => {
  assert.equal(evaluateCaptureGuard(idle).ok, false);
  const result = evaluateCaptureGuard(idle, isolated);
  assert.equal(result.ok, true);
  assert.deepEqual(result.listeners, idle.listeners);
});

test('isolation refuses a foreign MailVault app even when its driver is orphaned', () => {
  const state = { ...idle, processes: [...idle.processes, { pid: 12, ppid: 10, command: '/deleted-clone/target/debug/mailvault' }] };
  assert.match(evaluateCaptureGuard(state, isolated).reasons.join('; '), /MailVault app already running: 12/);
  for (const command of ['mailvault', './MailVault', '/some/custom/location/MailVault']) {
    assert.equal(evaluateCaptureGuard({ ...idle, processes: [{ pid: 12, ppid: 1, command }] }, isolated).ok, false);
  }
  assert.equal(evaluateCaptureGuard({ ...idle, processes: [{ pid: 12, ppid: 1,
    executable: '/some/custom location/MailVault', command: '/some/custom location/MailVault --example' }] }, isolated).ok, false);
});

test('isolation refuses capture-port overlap, active infrastructure and missing global lock', () => {
  assert.equal(evaluateCaptureGuard({ ...idle, listeners: [...idle.listeners, { pid: 99, port: 4468 }] }, isolated).ok, false);
  assert.equal(evaluateCaptureGuard({ ...idle, processes: [{ ...idle.processes[0], ppid: 20 }] }, isolated).ok, false);
  assert.equal(evaluateCaptureGuard({ ...idle, globalRunnerHeld: false }, isolated).ok, false);
});

test('same-checkout UI worker blocks; only actual current ancestry is exempt', () => {
  const worker = { pid: 21, ppid: 20, command: 'node /other/node_modules/@wdio/local-runner/build/run.js run wdio.conf.js' };
  assert.equal(evaluateCaptureGuard({ ...idle, processes: [...idle.processes, worker] }, isolated).ok, false);
  const own = { ...worker, command: 'node /capture/node_modules/@wdio/local-runner/build/run.js run wdio.footage.conf.js' };
  assert.equal(evaluateCaptureGuard({ ...idle, processes: [...idle.processes, own] }, isolated).ok, false);
  assert.equal(evaluateCaptureGuard({ ...idle, currentPid: 21, processes: [...idle.processes, own] }, isolated).ok, true);
});

test('bounded preflight wait observes natural exit and never waits beyond its limit', async () => {
  let milliseconds = 0, calls = 0;
  const clock = { now: () => milliseconds, pause: async (duration) => { milliseconds += duration; } };
  const conflict = { ok: false, globalRunnerHeld: true, reasons: ['app'] };
  const resolved = await waitForCaptureGuard(() => ({ ...conflict, ok: ++calls === 3 }), { ...clock, waitSeconds: 6 });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.waitedSeconds, 4);
  milliseconds = 0;
  const timeout = await waitForCaptureGuard(() => conflict, { ...clock, waitSeconds: 5 });
  assert.equal(timeout.ok, false);
  assert.equal(timeout.waitedSeconds, 5);
  milliseconds = 0;
  const immediate = await waitForCaptureGuard(() => conflict, clock);
  assert.equal(immediate.waitedSeconds, 0);
  const unlocked = await waitForCaptureGuard(() => ({ ...conflict, globalRunnerHeld: false }), { ...clock, waitSeconds: 5 });
  assert.equal(unlocked.waitedSeconds, 0);
});
