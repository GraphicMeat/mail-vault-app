import { t } from '../i18n/index.js';
// Human-readable byte formatting shared by data-usage UI (sidebar bubble,
// settings page, warn banner). KB/MB/GB, 1 decimal place.
export function formatBytes(bytes) {
  if (bytes == null || Number.isNaN(bytes)) return '--';
  if (bytes < 1024) return t('settings.backup.account.b', { bytes });
  if (bytes < 1024 * 1024) return t('settings.backup.account.kb', { bytes: (bytes / 1024).toFixed(1) });
  if (bytes < 1024 * 1024 * 1024) return t('settings.backup.account.mb', { bytes: (bytes / (1024 * 1024)).toFixed(1) });
  return t('settings.backup.account.gb', { bytes: (bytes / (1024 * 1024 * 1024)).toFixed(1) });
}
