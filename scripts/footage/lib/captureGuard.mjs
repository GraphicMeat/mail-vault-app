/** Shared preflight for the shell runner and WebDriver launch.
 * Opt-in help captures may coexist with orphaned, idle infrastructure on other
 * ports. A foreign app, active UI test, occupied capture port, or missing global
 * runner lock always blocks that mode. This module never stops a process.
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function evaluateCaptureGuard(state, { allowIdleForeign = false, driverPort = 4468 } = {}) {
  const reasons = [];
  const infrastructure = [];
  const applications = [];
  const uiTests = [];
  const ancestors = new Set();
  let ancestor = state.processes.find((entry) => entry.pid === state.currentPid);
  while (ancestor && !ancestors.has(ancestor.pid)) {
    ancestors.add(ancestor.pid);
    ancestor = state.processes.find((entry) => entry.pid === ancestor.ppid);
  }
  for (const process of state.processes) {
    const executable = process.executable || process.command.trim().split(/\s+/)[0];
    const name = executable.split('/').at(-1);
    if (/^tauri-wd(?:-shots)?$/.test(name) || name === 'mock-imap-server') infrastructure.push(process);
    if (/^mailvault$/i.test(name)) applications.push(process);
    const ownFootage = ancestors.has(process.pid);
    if (!ownFootage && (/^xcodebuild$/.test(name) && /\btest\b/.test(process.command)
      || /XCTRunner|UITests-Runner/.test(name)
      || /@wdio\/local-runner\/build\/run\.js/.test(process.command))) uiTests.push(process);
  }
  const listeners = state.listeners.filter((entry) => infrastructure.some((process) => process.pid === entry.pid));
  if (state.listeners.some((entry) => entry.port === driverPort)) reasons.push(`capture port ${driverPort} is occupied`);
  if (applications.length) reasons.push(`MailVault app already running: ${applications.map((p) => p.pid).join(', ')}`);
  if (uiTests.length) reasons.push(`active UI test: ${uiTests.map((p) => p.pid).join(', ')}`);
  if (!allowIdleForeign && infrastructure.length) reasons.push(`driver or mock server already running: ${infrastructure.map((p) => p.pid).join(', ')}`);
  if (allowIdleForeign) {
    if (!state.globalRunnerHeld) reasons.push('isolated capture requires the global minijob runner lock');
    const active = infrastructure.filter((process) => process.ppid !== 1);
    if (active.length) reasons.push(`foreign infrastructure still has a live parent: ${active.map((p) => p.pid).join(', ')}`);
  }
  return { ok: reasons.length === 0, allowIdleForeign, driverPort, globalRunnerHeld: state.globalRunnerHeld,
    reasons, infrastructure, applications, uiTests, listeners };
}

export function readCaptureState() {
  const processes = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' }).split('\n').flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }] : [];
  });
  const executableByPid = new Map(execFileSync('ps', ['-axo', 'pid=,comm='], { encoding: 'utf8' }).split('\n').flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    return match ? [[Number(match[1]), match[2]]] : [];
  }));
  for (const entry of processes) entry.executable = executableByPid.get(entry.pid);
  const listeners = [];
  let output = '';
  try { output = execFileSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch (error) { if (error.status !== 1) throw error; }
  let pid;
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n')) {
      const port = line.match(/:(\d+)$/);
      if (pid && port) listeners.push({ pid, port: Number(port[1]), address: line.slice(1) });
    }
  }
  const ancestors = [];
  let current = processes.find((entry) => entry.pid === process.pid);
  while (current && !ancestors.some((entry) => entry.pid === current.pid)) {
    ancestors.push(current);
    current = processes.find((entry) => entry.pid === current.ppid);
  }
  const globalRunnerHeld = ancestors.some((entry) => /(?:^|\s)(?:\/usr\/bin\/)?lockf\s+-k\s+\S*\/jobs\/mail-vault-app\.lock(?:\s|$)/.test(entry.command));
  return { processes, listeners, globalRunnerHeld, currentPid: process.pid };
}

export function inspectCaptureGuard() {
  return evaluateCaptureGuard(readCaptureState(), {
    allowIdleForeign: process.env.FOOTAGE_ALLOW_IDLE_FOREIGN === '1',
    driverPort: Number(process.env.FOOTAGE_PORT || 4468), root: process.cwd(),
  });
}

export async function waitForCaptureGuard(inspect, {
  waitSeconds = 0, intervalMs = 2000, now = Date.now,
  pause = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds)),
  report = () => {},
} = {}) {
  const started = now();
  let result = inspect();
  while (!result.ok && result.globalRunnerHeld && now() - started < waitSeconds * 1000) {
    report(result);
    await pause(Math.min(intervalMs, waitSeconds * 1000 - (now() - started)));
    result = inspect();
  }
  return { ...result, waitedSeconds: (now() - started) / 1000 };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const waitSeconds = process.env.FOOTAGE_ALLOW_IDLE_FOREIGN === '1'
    ? Math.min(600, Math.max(0, Number(process.env.FOOTAGE_GUARD_WAIT_SECONDS) || 0)) : 0;
  let lastReason = '';
  const result = await waitForCaptureGuard(inspectCaptureGuard, { waitSeconds, report: (state) => {
    const reason = state.reasons.join('; ');
    if (reason !== lastReason) console.error(`capture preflight waiting (up to ${waitSeconds}s): ${reason}`);
    lastReason = reason;
  } });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    console.error(`capture preflight refused: ${result.reasons.join('; ')}`);
    process.exitCode = 1;
  }
}
