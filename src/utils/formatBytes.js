// Human-readable byte formatting shared by data-usage UI (sidebar bubble,
// settings page, warn banner). KB/MB/GB, 1 decimal place.
export function formatBytes(bytes) {
  if (bytes == null || Number.isNaN(bytes)) return '--';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
