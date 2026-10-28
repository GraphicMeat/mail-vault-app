// First actual O caller capture only. Concatenate the real old caller outputs
// without writing or deriving any expected decision by hand. Run on the
// approved remote host, preserve input files, stdout and this output's SHA.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const names = ['MV_UNREAD_O_OUTPUT','MV_UNREAD_O04_OUTPUT','MV_UNREAD_O_CANONICAL'];
for (const name of names) if (!process.env[name]) throw Error(`Missing ${name}`);
const first = JSON.parse(fs.readFileSync(process.env.MV_UNREAD_O_OUTPUT,'utf8'));
const fourth = JSON.parse(fs.readFileSync(process.env.MV_UNREAD_O04_OUTPUT,'utf8'));
assert.equal(first.version,1);
assert.equal(fourth.version,1);
assert.deepEqual(first.cases.map(x=>x.id),['O01','O02','O03']);
assert.deepEqual(fourth.cases.map(x=>x.id),['O04']);
const bytes = Buffer.from(JSON.stringify({version:1,cases:[...first.cases,...fourth.cases]},null,2)+'\n');
fs.writeFileSync(process.env.MV_UNREAD_O_CANONICAL,bytes,{flag:'wx'});
process.stdout.write('W4S3_UNREAD_O_CANONICAL '+JSON.stringify({cases:4,
  sha256:crypto.createHash('sha256').update(bytes).digest('hex')})+'\n');
