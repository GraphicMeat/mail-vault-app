import { pickFolder, startExportJob, runAttachmentExport } from './attachmentExport';

/// Save every contact as one vCard file in a folder the person picks. The
/// daemon writes the file; this only picks the folder and waits for the job.
/// `title` is the already translated title of the folder picker.
export async function exportContacts(title) {
  const folder = await pickFolder(title);
  if (!folder) return { ok: false, cancelled: true };
  try {
    await runAttachmentExport('contacts', (jobId) => startExportJob('people.export_vcf', folder, { jobId, destDir: folder }));
    return { ok: true };
  } catch (e) {
    return { ok: false, errorKey: 'contacts.exportFailed', detail: String(e?.message || e) };
  }
}
