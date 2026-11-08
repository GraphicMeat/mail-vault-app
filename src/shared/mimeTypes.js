// File extension <-> media type. The same table, in the same order, as the Rust core's
// `src-core/src/mime_types.rs` (a test compares them). The first row for a media type is its
// canonical extension; later rows only map name -> type.

export const OCTET_STREAM = 'application/octet-stream';

export const MIME_TABLE = [
  ['pdf', 'application/pdf'],
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['gif', 'image/gif'],
  ['webp', 'image/webp'],
  ['heic', 'image/heic'],
  ['heif', 'image/heif'],
  ['txt', 'text/plain'],
  ['csv', 'text/csv'],
  ['html', 'text/html'],
  ['htm', 'text/html'],
  ['ics', 'text/calendar'],
  ['vcf', 'text/vcard'],
  ['eml', 'message/rfc822'],
  ['json', 'application/json'],
  ['zip', 'application/zip'],
  ['doc', 'application/msword'],
  ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['xls', 'application/vnd.ms-excel'],
  ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['ppt', 'application/vnd.ms-powerpoint'],
  ['pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  ['mp3', 'audio/mpeg'],
  ['m4a', 'audio/mp4'],
  ['mp4', 'video/mp4'],
  ['mov', 'video/quicktime'],
];

/// The media type for a file name's extension (case-insensitive); octet-stream when it says nothing.
export function mimeFromName(name) {
  const base = String(name || '');
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
  return MIME_TABLE.find(([e]) => e === ext)?.[1] || OCTET_STREAM;
}

/// The canonical extension for a media type (parameters ignored), or null.
export function extForMime(mime) {
  const base = String(mime || '').split(';')[0].trim().toLowerCase();
  return MIME_TABLE.find(([, m]) => m === base)?.[0] ?? null;
}
