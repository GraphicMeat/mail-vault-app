/**
 * Task 3.5 Step 4 (spec deviation 2, R3.5): the daemon's archive/bulk/verify
 * routes must never accept a mirror/backup-path parameter — only the
 * app-side `run_with_backup` shim (`src-tauri/src/archive.rs`, called from
 * `backup.rs`, deferred with backup) does. Task 3.4's review already
 * confirmed this is true STRUCTURALLY at this commit:
 * `src-daemon/src/handlers/archive.rs` calls `mailvault_core::archive::run`
 * (never `run_with_backup`), so there is no mirror-shaped parameter path to
 * find in the source at all today. This guard is a forward regression
 * fence, not a fix for a bug found now.
 *
 * The plan's own suggested negative control (plant an offender on the
 * runner copy) would mean planting the very thing this file proves does not
 * exist, which proves nothing about the guard's sensitivity. Instead the
 * pattern is proven non-vacuous against inline fixture strings shaped like a
 * real regression — a `params.get("mirrorRoot")` read, a `mirror:` struct
 * field/argument, a `backup_path` identifier — and proven NOT to fire on the
 * file's own prose (the one real occurrence of the word "mirror" in
 * archive.rs today is the English phrase "mirror image", in a test doc
 * comment, not a parameter).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const SOURCE_PATH = 'src-daemon/src/handlers/archive.rs';

// A parameter read or struct field/argument shaped like a mirror/backup
// path — not the bare English word "mirror" on its own, which the file's
// prose comments are allowed to use.
const MIRROR_PARAM_PATTERN = /params\s*\.\s*get\s*\(\s*["']mirror\w*["']\s*\)|\bmirror(?:_root|Root)?\s*:|\bbackup_path\b/;

function hasMirrorParam(text) {
  return MIRROR_PARAM_PATTERN.test(text);
}

describe('daemon archive routes never receive a mirror parameter (no-mirror fence)', () => {
  it('negative control: fires on a planted params.get("mirrorRoot") read', () => {
    expect(hasMirrorParam('let mirror_root = req!(str_arg(&id, params, "mirrorRoot"));\nparams.get("mirrorRoot")')).toBe(true);
  });

  it('negative control: fires on a planted mirror: struct field/argument', () => {
    expect(hasMirrorParam('ArchiveCtx { root, pool, gate, sinks, mirror: Some(mirror_path) }')).toBe(true);
  });

  it('negative control: fires on a planted backup_path identifier', () => {
    expect(hasMirrorParam('let backup_path = req!(str_arg(&id, params, "backupPath"));')).toBe(true);
  });

  it('negative control: the bare word "mirror" in prose does not fire (would be a false positive, not a real regression)', () => {
    expect(hasMirrorParam('// The mirror image of the two tests above: an ungated route must NOT')).toBe(false);
  });

  it('src-daemon/src/handlers/archive.rs has no mirror-shaped parameter path today', () => {
    const source = readFileSync(SOURCE_PATH, 'utf8');
    expect(hasMirrorParam(source)).toBe(false);
  });
});
