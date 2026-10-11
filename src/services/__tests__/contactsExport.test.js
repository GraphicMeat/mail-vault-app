import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ pickFolder: vi.fn(), startExportJob: vi.fn(), runAttachmentExport: vi.fn() }));
vi.mock('../attachmentExport', () => h);

import { exportContacts } from '../contactsExport';

const t = (k) => k;

beforeEach(() => {
  h.pickFolder.mockReset();
  h.startExportJob.mockReset();
  h.runAttachmentExport.mockReset();
});

describe('exportContacts', () => {
  it('a cancelled folder pick starts nothing', async () => {
    h.pickFolder.mockResolvedValue(null);
    await expect(exportContacts(t)).resolves.toEqual({ ok: false, cancelled: true });
    expect(h.pickFolder).toHaveBeenCalledWith('contacts.export');
    expect(h.runAttachmentExport).not.toHaveBeenCalled();
    expect(h.startExportJob).not.toHaveBeenCalled();
  });

  it('starts the export job in the picked folder and resolves ok when it finishes', async () => {
    h.pickFolder.mockResolvedValue('/Users/me/Downloads');
    h.runAttachmentExport.mockImplementation(async (_key, start) => { await start('job-1'); return { count: 2 }; });
    await expect(exportContacts(t)).resolves.toEqual({ ok: true });
    expect(h.runAttachmentExport).toHaveBeenCalledWith('contacts', expect.any(Function));
    expect(h.startExportJob).toHaveBeenCalledWith('people.export_vcf', '/Users/me/Downloads', { jobId: 'job-1', destDir: '/Users/me/Downloads' });
  });

  it('a failed job gives the catalog key, not the raw error', async () => {
    h.pickFolder.mockResolvedValue('/x');
    h.runAttachmentExport.mockRejectedValue(new Error('contacts.exportFailed'));
    await expect(exportContacts(t)).resolves.toEqual({ ok: false, errorKey: 'contacts.exportFailed', detail: 'contacts.exportFailed' });
  });
});
