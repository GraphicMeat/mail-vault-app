// Archived source oracle for the pre-daemon bulk manager. Only explicit remote
// generation writes answers; ordinary runs compare the live manager to them.
import { it, expect, vi } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const oracle = vi.hoisted(() => ({ trace: [], pending: [], script: {}, handlers: {} }));
const clone = value => JSON.parse(JSON.stringify(value));
vi.mock('../../../../src/services/api', () => ({
  savePendingOperation: async value => oracle.pending.push(JSON.parse(JSON.stringify(value))),
  clearPendingOperation: async () => oracle.trace.push({ effect: 'clear' }),
  verifyArchivedEmails: async (accountId, mailbox, uids) => {
    oracle.trace.push({ effect: 'verify', accountId, mailbox, uids: [...uids] });
    return { verified: uids.filter(u => u !== oracle.script.missing), missing: uids.filter(u => u === oracle.script.missing) };
  },
  backupCopyUids: async (accountId, _email, mailbox, uids) => {
    oracle.trace.push({ effect: 'copy', accountId, mailbox, uids: [...uids] });
    return { verified: [...uids, 9999], mismatched: [], missing: [] };
  },
  bulkDeleteEmails: async (_account, accountId, mailbox, uids, options) => {
    oracle.trace.push({ effect: 'delete', accountId, mailbox, uids: [...uids], bin: options?.bin ?? true });
    return { completed: uids.length };
  },
}));
vi.mock('../../../../src/services/authUtils', () => ({ ensureFreshToken: async account => account }));
vi.mock('@tauri-apps/api/event', () => ({ listen: async (name, handler) => { oracle.handlers[name] = handler; return () => {}; } }));
vi.mock('../../../../src/services/transport.js', () => ({ send: async (cmd, p) => {
  if (cmd === 'archive_emails') {
    oracle.trace.push({ effect: 'archive', accountId: p.accountId, mailbox: p.mailbox, uids: [...p.uids], background: p.background });
    oracle.handlers['archive-progress']?.({ payload: { operation: 'archive', accountId: 'foreign', mailbox: p.mailbox, completed: 99, errors: 99 } });
    if (oracle.script.throwArchive) throw new Error('scripted archive failure');
    oracle.handlers['archive-progress']?.({ payload: { operation: 'archive', accountId: p.accountId, mailbox: p.mailbox, completed: p.uids.length, errors: 0 } });
  }
  return {};
} }));
vi.mock('../../../../src/services/workflows/messageMutations', () => ({ purgeEverywhere: async (keys, { onProgress }) => {
  oracle.trace.push({ effect: 'purge', keys: [...keys] });
  for (const phase of ['delete', 'vault', 'backup']) onProgress({ phase, total: phase === 'delete' ? keys.length : 1, completed: phase === 'delete' ? keys.length : 0 });
  return { deleted: keys.length, failed: 0, queuedBackup: 0, needsResync: 0 };
} }));
import { groupBulkTargets, bulkOperationManager } from '../../../../src/services/BulkOperationManager.js';
const session = { accountId: 'acc1', mailbox: 'INBOX', spans: false };
const selections = [
  ['mixed', [1, 'acc1:Sent:5', 2, 'acc2:INBOX:1']],
  ['duplicates', [3, 'acc1:INBOX:3', '03', 'acc1:INBOX:4', 3]],
  ['mailbox-colon', ['acc1:Work:Clients:9']],
  ['ambiguous', ['acc1:5', 'acc1:UNIFIED:6', 'acc1:INBOX:x', 'x', null]],
  ['spanning', [3, 'acc1:INBOX:4'], { ...session, spans: true }],
  ['unified', [3, 'acc1:INBOX:4'], { ...session, mailbox: 'UNIFIED' }],
  ['missing-session', [1], { mailbox: 'INBOX' }],
  ['numeric-boundaries', [0, -1, 4294967295, 4294967296, 1.5, '9007199254740992']],
  ['unknown-account', ['missing:INBOX:1']],
  ['empty', []],
];

it('captures real source decisions with deterministic dependency replies', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-24T00:00:00.000Z'));
  globalThis.window = { __TAURI__: { core: { invoke() {} } } };
  try {
    const grouping = selections.map(([name, keys, scope = session]) => ({ name, keys, scope, ...groupBulkTargets(keys, scope) }));
    const runs = [];
    const accounts = [{ id: 'acc1', email: 'one@example.test' }, { id: 'acc2', email: 'two@example.test' }];
    const cases = [
      ...['archive', 'delete', 'archive_and_delete', 'archive_backup_delete', 'delete_everywhere'].map(type => ({ name: type, type, keys: [1, 'acc1:Sent:2', 'acc2:INBOX:1'] })),
      { name: 'verify-subset', type: 'archive_and_delete', keys: [1, 2], script: { missing: 2 } },
      { name: 'copy-201', type: 'archive_backup_delete', keys: Array.from({ length: 201 }, (_, i) => i + 1) },
      { name: 'skipped', type: 'archive', keys: ['missing:INBOX:1', 'acc1:Local:2', 'bad'] },
      { name: 'empty', type: 'delete', keys: [] },
      { name: 'archive-error', type: 'archive_and_delete', keys: [1], script: { throwArchive: true } },
      { name: 'resume-some', type: 'archive', keys: ['acc1:Sent:1', 'acc2:INBOX:2'], completed: ['acc1:Sent:1'] },
      { name: 'resume-all', type: 'delete', keys: [1], completed: [1] },
      { name: 'resume-none', type: 'archive_and_delete', keys: ['acc1:Work:Clients:9'], completed: [], phase: 'delete' },
      { name: 'resume-missing-account', type: 'delete', keys: ['missing:INBOX:7'], completed: [], phase: 'delete' },
    ];
    for (const c of cases) {
      oracle.trace = []; oracle.pending = []; oracle.handlers = {}; oracle.script = c.script || {};
      const snapshots = [];
      const onProgress = op => snapshots.push(clone(op));
      const args = { type: c.type, ...session, account: accounts[0], accounts, localFolders: { acc1: [{ name: 'Local', dir: 'Local' }] }, uids: c.keys, onProgress };
      const resumeInput = c.completed ? { id: `legacy-${c.name}`, type: c.type, ...session, totalUids: c.keys, completedUids: c.completed, currentPhase: c.phase || 'archive', status: 'error' } : null;
      if (resumeInput) await bulkOperationManager.resume(resumeInput, accounts[0], onProgress, args);
      else await bulkOperationManager.start(args);
      runs.push({ name: c.name, type: c.type, keys: c.keys, resumeInput, trace: clone(oracle.trace), pending: clone(oracle.pending), snapshots });
    }
    const fixture = {
      schemaVersion: 1,
      source: { baseCommit: execFileSync('git', ['rev-parse', 'HEAD^'], { encoding: 'utf8' }).trim(), snapshotCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), generatorSha256: createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex') },
      grouping, runs,
    };
    const path = new URL('../bulk-operation-cases.json', import.meta.url);
    if (process.env.MAILVAULT_GENERATE_BULK_FIXTURE === '1') {
      writeFileSync(path, JSON.stringify(fixture, null, 2) + '\n');
      console.log('BULK_FIXTURE_BASE64_BEGIN');
      console.log(Buffer.from(readFileSync(path)).toString('base64'));
      console.log('BULK_FIXTURE_BASE64_END');
    } else {
      const saved = JSON.parse(readFileSync(path, 'utf8'));
      expect(fixture.grouping).toEqual(saved.grouping);
      expect(fixture.runs).toEqual(saved.runs);
    }
    expect(runs.find(r => r.name === 'copy-201').trace.filter(e => e.effect === 'copy').map(e => e.uids.length)).toEqual([100, 100, 1]);
  } finally { vi.useRealTimers(); }
});
