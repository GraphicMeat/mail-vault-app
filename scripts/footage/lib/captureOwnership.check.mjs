import test from 'node:test';
import assert from 'node:assert/strict';
import { ownedCaptureProcesses } from './captureOwnership.mjs';

const launcher = { pid: 20, ppid: 2, command: 'node /capture/node_modules/.bin/wdio run wdio.footage.conf.js' };
const driver = { pid: 21, ppid: 20, command: 'tauri-wd-shots --port 4468' };
const ownership = { root: '/capture', bin: '/unique-bin', launcher, driver, baselinePids: [1, 2, 10, 11, 20] };

test('guard refusal without launch ownership selects no process', () => {
  assert.deepEqual(ownedCaptureProcesses([driver], null), []);
});

test('cleanup preserves pre-existing same-root mocks and prefix-matching foreign ports', () => {
  const oldMock = { pid: 10, ppid: 1, command: '/capture/target/debug/mock-imap-server' };
  const unrelatedDriver = { pid: 11, ppid: 1, command: 'tauri-wd-shots --port 44680' };
  const app = { pid: 22, ppid: 21, command: '/capture/target/debug/mailvault' };
  const daemon = { pid: 23, ppid: 1, command: '/capture/target/debug/mailvault-daemon' };
  assert.deepEqual(ownedCaptureProcesses([oldMock, unrelatedDriver, launcher, driver, app, daemon], ownership).map((entry) => entry.pid), [20, 21, 22, 23]);
});

test('changed recorded PID identity and sibling checkout executable are never owned', () => {
  const reused = { ...driver, command: 'unrelated service' };
  const sibling = { pid: 30, ppid: 1, command: '/capture-other/target/debug/mailvault' };
  assert.deepEqual(ownedCaptureProcesses([reused, sibling], ownership), []);
});
