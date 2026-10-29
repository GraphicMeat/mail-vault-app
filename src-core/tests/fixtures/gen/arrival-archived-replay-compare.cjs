// Compare only actual old-JS outputs from archived original test and code IDs.
// The immutable fixture is created from the first capture, never embedded here.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
for (const key of ['MV_ARRIVAL_ARCHIVE_MANIFEST','MV_ARRIVAL_CANONICAL','MV_ARRIVAL_REPLAY_OUTPUTS'])
  if (!process.env[key]) throw Error(`Missing ${key}`);
const manifest = JSON.parse(fs.readFileSync(process.env.MV_ARRIVAL_ARCHIVE_MANIFEST, 'utf8'));
if (!/^[0-9a-f]{40}$/.test(manifest.acceptedS3Commit || '') ||
    !['captured-for-replay','accepted-oracle'].includes(manifest.status))
  throw Error('S4 replay requires a pinned accepted S3 parent and a captured source archive');
const canonical = JSON.parse(fs.readFileSync(process.env.MV_ARRIVAL_CANONICAL, 'utf8'));
const outputs = process.env.MV_ARRIVAL_REPLAY_OUTPUTS.split(';').filter(Boolean);
if (outputs.length !== 14 || new Set(outputs).size !== 14) throw Error('Replay needs 14 distinct raw outputs');
const actual = outputs.flatMap(file => JSON.parse(fs.readFileSync(file, 'utf8')).cases);
const ids = manifest.cases.map(item => item.id);
assert.equal(ids.length, 66, 'Archive manifest needs 66 cases');
assert.equal(new Set(ids).size, 66, 'Archive IDs must be unique');
assert.equal(actual.length, 66, 'Archived replay output count differs');
assert.equal(new Set(actual.map(item => item.id)).size, 66, 'Archived replay IDs repeat');
const byId = new Map(actual.map(item => [item.id, item]));
assert.deepEqual([...byId.keys()].sort(), ids.slice().sort(), 'Archived replay ID set differs');
assert.deepEqual(canonical.cases.map(item => item.id), ids, 'Canonical case order differs');
assert.deepEqual(ids.map(id => byId.get(id)), canonical.cases,
  'Actual archived caller effects differ from first capture');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
process.stdout.write('W4S4_ARRIVAL_ARCHIVED_REPLAY_OK '+JSON.stringify({
  cases: actual.length, canonicalSha256: sha(fs.readFileSync(process.env.MV_ARRIVAL_CANONICAL))
})+'\n');
