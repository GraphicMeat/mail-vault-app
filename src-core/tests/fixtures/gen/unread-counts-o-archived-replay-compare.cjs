// Compare actual old caller traces produced under the archived Vite overlay.
// The remote carrier runs Vitest with the overlay config and preserves stdout,
// stderr, JSON reporter, fixture files, command exit and cleanup before this.
const fs=require('node:fs');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const required=['MV_UNREAD_O_CANONICAL','MV_UNREAD_O_OUTPUT','MV_UNREAD_O04_OUTPUT'];
for(const key of required) if(!process.env[key]) throw Error(`Missing ${key}`);
const old=JSON.parse(fs.readFileSync(process.env.MV_UNREAD_O_CANONICAL,'utf8'));
const first=JSON.parse(fs.readFileSync(process.env.MV_UNREAD_O_OUTPUT,'utf8'));
const fourth=JSON.parse(fs.readFileSync(process.env.MV_UNREAD_O04_OUTPUT,'utf8'));
const actual={version:1,cases:[...first.cases,...fourth.cases]};
assert.deepEqual(actual.cases.map(x=>x.id),['O01','O02','O03','O04']);
assert.deepEqual(actual,old,'actual archived caller output differs from first capture');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
process.stdout.write('W4S3_UNREAD_O_ARCHIVED_REPLAY_OK '+JSON.stringify({cases:4,
  canonicalSha256:sha(fs.readFileSync(process.env.MV_UNREAD_O_CANONICAL))})+'\n');
