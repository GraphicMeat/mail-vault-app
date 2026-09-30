// The header memo keeps a folder's rows as they were when it was left, before
// the search index had read a body that arrived meanwhile. Reopening the
// folder served those rows with no `previewText`; a disk read stamps it. This
// pins the stamp the memo path now applies.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetEmailHeadersByUids = vi.fn();
vi.mock('../db', () => ({
  getEmailHeadersByUids: (...a) => mockGetEmailHeadersByUids(...a),
}));

import { stampIndexPreviews, PREVIEW_WINDOW } from '../indexSnippet';

beforeEach(() => { mockGetEmailHeadersByUids.mockReset(); });

describe('stampIndexPreviews', () => {
  it('stamps the index preview on a row that has none', async () => {
    mockGetEmailHeadersByUids.mockResolvedValue([{ uid: 2, previewText: 'the start of the body' }]);
    const rows = [{ uid: 1, subject: 'a' }, { uid: 2, subject: 'b' }];
    const out = await stampIndexPreviews('acc', 'INBOX', rows);
    expect(mockGetEmailHeadersByUids).toHaveBeenCalledWith('acc', 'INBOX', [1, 2]);
    expect(out.find((r) => r.uid === 2).previewText).toBe('the start of the body');
    expect(out.find((r) => r.uid === 1).previewText).toBeUndefined();
    expect(rows[1].previewText).toBeUndefined(); // the memo's own rows are not mutated
  });

  it('asks nothing of the daemon for rows that already carry a preview', async () => {
    const rows = [{ uid: 1, previewText: 'kept' }, { uid: 2, snippet: 'own' }];
    const out = await stampIndexPreviews('acc', 'INBOX', rows);
    expect(mockGetEmailHeadersByUids).not.toHaveBeenCalled();
    expect(out).toBe(rows);
  });

  it('reads at most the first window, the size of the disk read it stands in for', async () => {
    mockGetEmailHeadersByUids.mockResolvedValue([]);
    const rows = Array.from({ length: PREVIEW_WINDOW + 50 }, (_, i) => ({ uid: i + 1 }));
    await stampIndexPreviews('acc', 'INBOX', rows);
    expect(mockGetEmailHeadersByUids.mock.calls[0][2]).toHaveLength(PREVIEW_WINDOW);
  });

  it('returns the rows untouched when the read fails', async () => {
    mockGetEmailHeadersByUids.mockRejectedValue(new Error('daemon down'));
    const rows = [{ uid: 1 }];
    expect(await stampIndexPreviews('acc', 'INBOX', rows)).toBe(rows);
  });
});
