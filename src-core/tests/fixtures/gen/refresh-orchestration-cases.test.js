// @vitest-environment jsdom
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';

const require = createRequire(import.meta.url);
const { capture, caseManifest } = require('./refresh-orchestration-capture.cjs');
const SPEC = 'src-core/tests/fixtures/gen/refresh-orchestration-cases.test.js';

function emitReplayChild(label, value) {
  if (value == null) {
    process.stdout.write('W4S2_ORACLE_REPLAY_CHILD_' + label + '_INFO '
      + JSON.stringify({ present: false }) + '\n');
    return;
  }
  const bytes = Buffer.from(value);
  const encoded = bytes.toString('base64');
  process.stdout.write('W4S2_ORACLE_REPLAY_CHILD_' + label + '_INFO '
    + JSON.stringify({ present: true, bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex') }) + '\n');
  process.stdout.write('W4S2_ORACLE_REPLAY_CHILD_' + label + '_BEGIN\n');
  for (let i = 0; i < encoded.length; i += 4096) {
    process.stdout.write(encoded.slice(i, i + 4096) + '\n');
  }
  process.stdout.write('W4S2_ORACLE_REPLAY_CHILD_' + label + '_END\n');
}

function replayWithVmEnabled() {
  if (process.env.MV_REFRESH_ORACLE_REPLAY_CHILD === '1') {
    throw Error('VM modules unavailable in the explicitly flagged replay child');
  }
  const scratch = mkdtempSync(path.join(tmpdir(), 'w4s2-oracle-replay-'));
  try {
    const config = path.join(scratch, 'vitest.config.mjs');
    const reportFile = path.join(scratch, 'vitest.json');
    const text = 'export default { root: ' + JSON.stringify(process.cwd())
      + ', test: { include: [' + JSON.stringify(SPEC)
      + '], exclude: [], testTimeout: 180000 } };\n';
    writeFileSync(config, text);
    const cli = path.resolve('node_modules/vitest/vitest.mjs');
    const nodeOptions = [process.env.NODE_OPTIONS || '', '--experimental-vm-modules'].join(' ').trim();
    const child = spawnSync(process.execPath, ['--experimental-vm-modules', cli,
      'run', SPEC, '--config', config, '--reporter=json', '--outputFile=' + reportFile], {
      cwd: process.cwd(), maxBuffer: 64 * 1024 * 1024, timeout: 20 * 60 * 1000,
      env: { ...process.env, MV_REFRESH_ORACLE_REPLAY_CHILD: '1',
        NODE_OPTIONS: nodeOptions, NO_COLOR: '1', FORCE_COLOR: '0' },
    });
    const reportBytes = existsSync(reportFile) ? readFileSync(reportFile) : null;
    process.stdout.write('W4S2_ORACLE_REPLAY_CHILD_PROCESS '
      + JSON.stringify({ exit: child.status, signal: child.signal,
        error: child.error ? { name: child.error.name, message: child.error.message,
          code: child.error.code || null, stack: child.error.stack || null } : null }) + '\n');
    emitReplayChild('STDOUT', child.stdout);
    emitReplayChild('STDERR', child.stderr);
    emitReplayChild('JSON', reportBytes);
    if (child.status !== 0) {
      throw Error('VM replay child failed; complete stdout, stderr and JSON frames precede this error');
    }
    if (!reportBytes) throw Error('VM replay child produced no JSON report');
    const report = JSON.parse(reportBytes.toString('utf8'));
    expect(report.success).toBe(true);
    expect(report.numTotalTests).toBe(1);
    expect(report.numPassedTests).toBe(1);
    expect(report.numFailedTests).toBe(0);
  } finally {
    let cleanupError = null;
    try { rmSync(scratch, { recursive: true, force: true }); }
    catch (error) { cleanupError = error; }
    const removed = !existsSync(scratch);
    process.stdout.write('W4S2_ORACLE_REPLAY_CHILD_CLEANUP '
      + JSON.stringify({ removed, error: cleanupError
        ? { name: cleanupError.name, message: cleanupError.message } : null }) + '\n');
    if (cleanupError) throw cleanupError;
  }
}

it('captures the accepted JavaScript refresh, adoption and real React scheduler oracle', async () => {
  const requireFallback = process.env.MV_REQUIRE_REFRESH_ORACLE_FALLBACK === '1'
    && process.env.MV_REFRESH_ORACLE_REPLAY_CHILD !== '1';
  if (requireFallback && vm.SourceTextModule) {
    throw Error('Ordinary replay unexpectedly had VM modules before wrapper fallback');
  }
  if (!vm.SourceTextModule) {
    console.log('W4S2_ORACLE_REPLAY_FALLBACK_USED');
    replayWithVmEnabled();
    if (process.env.MV_REFRESH_ORACLE_FALLBACK_WITNESS) {
      writeFileSync(process.env.MV_REFRESH_ORACLE_FALLBACK_WITNESS,
        'W4S2_ORACLE_REPLAY_FALLBACK_USED\n');
    }
    return;
  }
  const result = await capture({ vi, act, cleanup, renderHook });
  expect(result.manifest).toEqual(caseManifest);
  expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
});
