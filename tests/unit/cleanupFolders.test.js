/**
 * The rule picker and the cleanup engine share one folder policy.
 *
 * They did not before 2026-08-31: the picker offered "Drafts", executeRule()
 * refused every rule pointing at it, and the resulting rule row rendered
 * normally with its toggle on while nothing ever happened. Same silent no-op
 * class as the field-shape mismatch fixed the same day.
 *
 * The engine-side refusal stays (a hand-edited or migrated rule must still be
 * refused); this pins the other half, so the two lists cannot drift apart.
 */
import { describe, it, expect } from 'vitest';
import { CLEANUP_FOLDERS, PROTECTED_FOLDERS } from '../../src/utils/cleanupFolders';

describe('cleanup folder policy', () => {
  it('never offers a folder the engine would refuse', () => {
    expect(CLEANUP_FOLDERS.filter(f => PROTECTED_FOLDERS.has(f))).toEqual([]);
  });

  // Negative control: an empty picker also offers nothing protected.
  it('still offers the folders worth cleaning', () => {
    expect(CLEANUP_FOLDERS).toContain('INBOX');
    expect(CLEANUP_FOLDERS).toContain('Trash');
  });

  // Negative control: a protected set that lost its only member would let any
  // picker list pass the first assertion.
  it('still protects Drafts', () => {
    expect(PROTECTED_FOLDERS.has('Drafts')).toBe(true);
  });
});
