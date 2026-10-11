import { pickFolder, startExportJob, runAttachmentExport } from './attachmentExport';

/// Save every contact as one vCard file in a folder the person picks. The
/// daemon writes the file; this only picks the folder and waits for the job.
export async function exportContacts(t) {
  const folder = await pickFolder(t('contacts.export'));
  if (!folder) return { ok: false, cancelled: true };
  try {
    await runAttachmentExport('contacts', (jobId) => startExportJob('people.export_vcf', folder, { jobId, destDir: folder }));
    return { ok: true };
  } catch (e) {
    return { ok: false, errorKey: 'contacts.exportFailed', detail: String(e?.message || e) };
  }
}
