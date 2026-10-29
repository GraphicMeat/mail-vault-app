// Replay the original S4 arrival callers from their captured Vite source IDs.
// Decisions come only from the archived test/code bytes and canonical fixture.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const root = path.resolve(__dirname, '../../../../');
const specPath = path.join(__dirname, 'arrival-archived-replay-spec.json');
const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const read = name => fs.readFileSync(path.join(root, name));
const output = value => {
  const bytes = Buffer.from(String(value));
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (let offset = 0; offset < bytes.length;) {
    try {
      const n = fs.writeSync(1, bytes, offset, Math.min(16384, bytes.length - offset));
      if (n) offset += n;
      else Atomics.wait(pause, 0, 0, 5);
    } catch (error) {
      if (error.code !== 'EAGAIN') throw error;
      Atomics.wait(pause, 0, 0, 5);
    }
  }
};
const frame = (label, name) => {
  if (!name || !fs.existsSync(name)) return;
  const raw = fs.readFileSync(name);
  const compressed = zlib.gzipSync(raw);
  output('W4S4_DURABLE_REPLAY_' + label + '_INFO ' + JSON.stringify({
    rawBytes: raw.length, rawSha256: sha(raw),
    compressedBytes: compressed.length, compressedSha256: sha(compressed),
  }) + '\n');
  output('W4S4_DURABLE_REPLAY_' + label + '_BEGIN\n');
  const encoded = compressed.toString('base64');
  for (let i = 0; i < encoded.length; i += 4096) output(encoded.slice(i, i + 4096) + '\n');
  output('W4S4_DURABLE_REPLAY_' + label + '_END\n');
};
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const tests = spec.testFiles;
const titles = spec.selectedTitles;
const aliases = spec.outputAliases;
let scratch = null;
let receipt = { status: 'archived-arrival-replay', specSha256: sha(fs.readFileSync(specPath)),
  acceptedS3Commit: spec.acceptedS3Commit, captureHead: spec.captureHead,
  startedAt: new Date().toISOString(), commands: [] };
let passed = false;
const run = (name, argv, env) => {
  const stdout = path.join(scratch, name + '.stdout');
  const stderr = path.join(scratch, name + '.stderr');
  const outFd = fs.openSync(stdout, 'w');
  const errFd = fs.openSync(stderr, 'w');
  let proc;
  try {
    proc = cp.spawnSync(argv[0], argv.slice(1), {
      cwd: root, stdio: ['ignore', outFd, errFd], timeout: 30 * 60 * 1000,
      env: { ...process.env, ...env, NO_COLOR: '1', FORCE_COLOR: '0' },
    });
  } finally { fs.closeSync(outFd); fs.closeSync(errFd); }
  const result = { name, argv, exit: proc.status ?? (proc.signal ? 128 : 99),
    signal: proc.signal, error: proc.error?.message ?? null,
    stdoutSha256: sha(fs.readFileSync(stdout)), stderrSha256: sha(fs.readFileSync(stderr)) };
  receipt.commands.push(result);
  return { ...result, stdout, stderr };
};
try {
  if (spec.status !== 'accepted-s4-legacy-oracle' || spec.caseCount !== 66 ||
      tests.length !== 8 || new Set(tests).size !== 8 ||
      titles.length !== 16 || new Set(titles).size !== 16 ||
      aliases.length !== 14 || new Set(aliases).size !== 14 ||
      spec.caseOrder.length !== 66 || new Set(spec.caseOrder).size !== 66)
    throw Error('Archived arrival replay selection changed');
  for (const [name, expected] of [[spec.canonicalPath, spec.canonicalSha256],
      [spec.provenancePath, spec.provenanceSha256],
      [spec.archiveManifestPath, spec.archiveManifestSha256]]) {
    if (sha(read(name)) !== expected) throw Error('Pinned arrival artifact changed: ' + name);
  }
  const canonical = JSON.parse(read(spec.canonicalPath));
  const manifest = JSON.parse(read(spec.archiveManifestPath));
  if (canonical.caseCount !== 66 ||
      !same(canonical.cases.map(item => item.id), spec.caseOrder) ||
      manifest.acceptedS3Commit !== spec.acceptedS3Commit ||
      manifest.sourceHead !== spec.captureHead ||
      !same(manifest.cases.map(item => item.id), spec.caseOrder) ||
      !same(Object.keys(manifest.tests).sort(), tests.slice().sort()) ||
      Object.keys(manifest.files).length !== spec.sourceFileCount)
    throw Error('Canonical cases or Vite source manifest changed');
  const encodedNames = new Set();
  for (const [relative, expected] of Object.entries(manifest.files)) {
    if (relative.startsWith('/') || relative.split('/').includes('..'))
      throw Error('Invalid archived source path: ' + relative);
    const name = relative.replaceAll('/', '__') + '.base64';
    if (encodedNames.has(name)) throw Error('Archive path collision: ' + relative);
    encodedNames.add(name);
    const bytes = Buffer.from(read(path.join(spec.archiveDir, name)).toString('ascii').trim(), 'base64');
    if (sha(bytes) !== expected) throw Error('Archived source bytes differ: ' + relative);
  }
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'w4s4-durable-replay-'));
  const rawDir = path.join(scratch, 'raw');
  fs.mkdirSync(rawDir);
  const outputs = Object.fromEntries(aliases.map(alias => [alias, path.join(rawDir, alias + '.json')]));
  const reportPath = path.join(scratch, 'vitest.json');
  const nodeOptions = [process.env.NODE_OPTIONS || '', '--experimental-vm-modules'].join(' ').trim();
  const env = { TZ: 'UTC', NODE_OPTIONS: nodeOptions, MV_ARRIVAL_ROOT: root,
    MV_ARRIVAL_ARCHIVE_MANIFEST: path.join(root, spec.archiveManifestPath),
    MV_ARRIVAL_ARCHIVE_DIR: path.join(root, spec.archiveDir),
    MV_ARRIVAL_TEST_FILES: tests.join(';'), ...outputs };
  const argv = [process.execPath, path.join(root, 'node_modules/vitest/vitest.mjs'),
    'run', ...tests, '--config', path.join(root, spec.overlayConfigPath),
    '--testNamePattern', titles.map(escapeRegex).join('|'),
    '--reporter=default', '--reporter=json', '--outputFile=' + reportPath];
  const runResult = run('vitest', argv, env);
  if (runResult.exit !== 0 || runResult.signal || runResult.error || !fs.existsSync(reportPath))
    throw Error('Archived arrival Vitest did not complete');
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const rows = (report.testResults || []).map(item => ({
    file: path.relative(root, path.resolve(item.name)).replace(/\\/g, '/'),
    assertions: item.assertionResults || [],
  }));
  const selected = rows.flatMap(row => row.assertions).filter(item => titles.includes(item.title));
  if (report.success !== true || report.numPassedTests !== 16 ||
      report.numFailedTests !== 0 || report.numFailedTestSuites !== 0 ||
      report.numTotalTests < 16 || report.numPendingTests !== report.numTotalTests - 16 ||
      !same(rows.map(item => item.file).sort(), tests.slice().sort()) ||
      selected.length !== 16 || new Set(selected.map(item => item.title)).size !== 16 ||
      selected.some(item => item.status !== 'passed'))
    throw Error('Archived arrival selected assertions did not qualify');
  const compareEnv = { MV_ARRIVAL_ARCHIVE_MANIFEST: path.join(root, spec.archiveManifestPath),
    MV_ARRIVAL_CANONICAL: path.join(root, spec.canonicalPath),
    MV_ARRIVAL_REPLAY_OUTPUTS: aliases.map(alias => outputs[alias]).join(';') };
  const compared = run('compare', [process.execPath, path.join(root, spec.comparePath)], compareEnv);
  if (compared.exit !== 0 || compared.signal || compared.error ||
      !fs.readFileSync(compared.stdout, 'utf8').includes('W4S4_ARRIVAL_ARCHIVED_REPLAY_OK'))
    throw Error('Archived arrival case comparison failed');
  receipt.caseCount = 66;
  receipt.selectedTitlesPassed = 16;
  passed = true;
} catch (error) {
  receipt.error = error.stack || String(error);
} finally {
  if (scratch) {
    for (const name of ['vitest', 'compare']) {
      frame(name.toUpperCase() + '_STDOUT_GZIP', path.join(scratch, name + '.stdout'));
      frame(name.toUpperCase() + '_STDERR_GZIP', path.join(scratch, name + '.stderr'));
    }
    frame('VITEST_JSON_GZIP', path.join(scratch, 'vitest.json'));
    for (const alias of aliases) frame('OUTPUT_' + alias + '_GZIP', path.join(scratch, 'raw', alias + '.json'));
    if (path.dirname(scratch) !== os.tmpdir() || !path.basename(scratch).startsWith('w4s4-durable-replay-'))
      throw Error('Refusing to remove unowned replay scratch');
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  receipt.cleanup = !scratch || !fs.existsSync(scratch);
  receipt.passed = passed && receipt.cleanup;
  output('W4S4_DURABLE_REPLAY_SUMMARY ' + JSON.stringify(receipt) + '\n');
  if (receipt.passed) output('W4S4_DURABLE_REPLAY_OK 66\n');
  process.exitCode = receipt.passed ? 0 : 1;
}
