/** Per-launch process ownership. No port/name-wide process signals. */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readCaptureState } from './captureGuard.mjs';

export function startCaptureOwnership(path, root, bin) {
  const state = readCaptureState();
  const launcher = state.processes.find((entry) => entry.pid === process.pid);
  writeFileSync(path, JSON.stringify({ root, bin, launcher, baselinePids: state.processes.map((entry) => entry.pid) }, null, 2));
}

export function recordCaptureDriver(path, pid) {
  const ownership = JSON.parse(readFileSync(path, 'utf8'));
  ownership.driver = readCaptureState().processes.find((entry) => entry.pid === pid);
  if (!ownership.driver) throw new Error(`cannot record capture driver identity ${pid}`);
  writeFileSync(path, JSON.stringify(ownership, null, 2));
}

export function ownedCaptureProcesses(processes, ownership) {
  if (!ownership) return [];
  const baseline = new Set(ownership.baselinePids);
  const exact = (entry, recorded) => recorded && entry.pid === recorded.pid && entry.command === recorded.command;
  const owned = new Set(processes.filter((entry) => exact(entry, ownership.launcher) || exact(entry, ownership.driver)).map((entry) => entry.pid));
  for (const entry of processes) {
    const executable = entry.executable || entry.command.trim().split(/\s+/)[0];
    if (!baseline.has(entry.pid) && (executable.startsWith(`${ownership.root}/target/`)
      || ownership.bin && executable.startsWith(`${ownership.bin}/`))) owned.add(entry.pid);
  }
  let previous;
  do {
    previous = owned.size;
    for (const entry of processes) if (!baseline.has(entry.pid) && owned.has(entry.ppid)) owned.add(entry.pid);
  } while (previous !== owned.size);
  return processes.filter((entry) => owned.has(entry.pid));
}

export async function cleanupCapture(path) {
  const ownership = JSON.parse(readFileSync(path, 'utf8'));
  const selected = ownedCaptureProcesses(readCaptureState().processes, ownership);
  const report = { selected, signalled: [] };
  const liveOwned = () => {
    const current = readCaptureState().processes;
    return selected.filter((entry) => current.some((now) => now.pid === entry.pid && now.command === entry.command));
  };
  for (const entry of liveOwned().reverse()) {
    try { process.kill(entry.pid, 'SIGTERM'); report.signalled.push({ pid: entry.pid, signal: 'SIGTERM' }); } catch { /* already exited */ }
  }
  for (let attempt = 0; attempt < 20 && liveOwned().length; attempt++) await new Promise((done) => setTimeout(done, 200));
  for (const entry of liveOwned()) {
    try { process.kill(entry.pid, 'SIGKILL'); report.signalled.push({ pid: entry.pid, signal: 'SIGKILL' }); } catch { /* already exited */ }
  }
  writeFileSync(path.replace(/\.json$/, '.cleanup.json'), JSON.stringify(report, null, 2));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await cleanupCapture(process.argv[2]);
}
