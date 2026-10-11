import { describe, expect, it, vi } from 'vitest';

vi.mock('../transport.js', () => ({ send: vi.fn() }));

import { errorMessage } from '../storageFormat.js';
import en from '../../i18n/locales/en.json';

// Every code the storage_format_* routes answer with, shown as a catalog
// sentence and never as the daemon's own text.
describe('storageFormat.errorMessage', () => {
  it.each([
    ['E_FORMAT_BUSY: j1', 'errors.formatBusy'],
    ['E_FORMAT_SAME: the vault is in this format already', 'errors.formatSame'],
    ['E_FORMAT_NOT_FOUND: no conversion to steer', 'errors.formatNotFound'],
    ['E_FORMAT_MOVE_BLOCKED: finish it first', 'errors.formatMoveBlocked'],
    ['E_FORMAT_RECLAIM_FAILED: the sweep stopped', 'errors.formatReclaimFailed'],
    ['E_FORMAT_PURGE_FAILED: some files stayed', 'errors.formatPurgeFailed'],
    ['E_FORMAT_IO: the state was not saved', 'errors.formatIo'],
  ])('%s reads as %s', (raw, key) => {
    expect(errorMessage(new Error(raw))).toBe(en[key]);
    expect(errorMessage(raw)).toBe(en[key]);
  });
});
