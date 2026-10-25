// Frozen legacy capture, actively checked against the current pure grouping seam.
// Ordered-effect replacement: native bulk_parity + bulk_worker (17 applicable
// legacy traces, not all 25 runs). See src-core/tests/fixtures/gen/bulk-operation-cases.md.
import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { groupBulkTargets } from '../../../../src/services/BulkOperationManager.js';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
it('preserves pinned legacy evidence and checks every saved group through current source', () => {
  if (process.env.MAILVAULT_GENERATE_BULK_FIXTURE === '1') throw new Error('Historical bulk fixture generation is forbidden against migrated native source');
  const bytes = readFileSync(new URL('../bulk-operation-cases.json', import.meta.url));
  expect(digest(bytes)).toBe('4b99208a0f1f0c5b3a2d7a96919c3c8f35747764346c02bf3d660c0f315475b8');
  const saved = JSON.parse(bytes);
  expect(saved.schemaVersion).toBe(1);
  expect(saved.source).toEqual({ baseCommit: 'cb8f523fac8f3688c3acf0ffe2d67c66f00e4752', snapshotCommit: '35cbe14f98afd4260733cc2fdcce30676d6b419e', generatorSha256: '45a1c0b5c0e318fcef2891d413c62a8e925f67794c84503ca788c667ee4b7504' });
  expect(digest(readFileSync(new URL('./bulk-operation-cases.capture.js', import.meta.url)))).toBe(saved.source.generatorSha256);
  expect(saved.grouping.map(group => group.name)).toEqual(['mixed', 'duplicates', 'mailbox-colon', 'ambiguous', 'spanning', 'unified', 'missing-session', 'numeric-boundaries', 'unknown-account', 'empty']);
  expect(saved.runs.map(run => run.name)).toEqual(['archive', 'delete', 'archive_and_delete', 'archive_backup_delete', 'delete_everywhere', 'verify-subset', 'copy-201', 'copy-partition', 'copy-drive-gone-later', 'copy-drive-gone-first', 'partial-delete', 'cancel-archive', 'cancel-verify', 'cancel-copy', 'cancel-delete', 'verify-error', 'delete-error', 'stray-verify', 'skipped', 'empty', 'archive-error', 'resume-some', 'resume-all', 'resume-none', 'resume-missing-account']);
  for (const { name, keys, scope, groups, refused } of saved.grouping) {
    expect(groupBulkTargets(keys, scope), name).toEqual({ groups, refused });
  }
});
