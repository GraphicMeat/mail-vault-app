// The words for an `abd-progress` frame, shared by the panel and the pill. `t`
// is the module translator: the calling component's `useT()` is what repaints
// it when the language changes.
// Every string is a catalog key; the tables are literal so the key guards and
// a reader can both see them.
import { formatDateTime, formatTime } from '../../utils/dateFormat';
import { mailboxLabel } from '../../utils/imapUtf7';
import { t } from '../../i18n/index.js';

export const WAIT_KEYS = {
  daily_limit: 'abd.wait.daily_limit',
  provider_limit: 'abd.wait.provider_limit',
  throttled: 'abd.wait.throttled',
  offline: 'abd.wait.offline',
  keychain: 'abd.wait.keychain',
};

export const PAUSE_KEYS = {
  user: 'abd.pause.user',
  sign_in_needed: 'abd.pause.sign_in_needed',
  drive_unavailable: 'abd.pause.drive_unavailable',
  vault_unavailable: 'abd.pause.vault_unavailable',
  account_missing: 'abd.pause.account_missing',
};

export const KEPT_KEYS = {
  download_failed: 'abd.kept.download_failed',
  vault_mismatch: 'abd.kept.vault_mismatch',
  vault_missing: 'abd.kept.vault_missing',
  mirror_mismatch: 'abd.kept.mirror_mismatch',
  mirror_missing: 'abd.kept.mirror_missing',
  server_changed: 'abd.kept.server_changed',
  no_all_mail_copy: 'abd.kept.no_all_mail_copy',
  already_in_trash: 'abd.kept.already_in_trash',
  not_emptied: 'abd.kept.not_emptied',
  cannot_delete: 'abd.kept.cannot_delete',
};

/** When a wait ends, in the reader's zone: a time today, a date and time on another day. */
export function formatResumeTime(ms) {
  const at = new Date(ms);
  if (Number.isNaN(at.getTime())) return '';
  const now = new Date();
  const today = at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth() && at.getDate() === now.getDate();
  return today ? formatTime(at) : formatDateTime(at);
}

/** The one-line status of a frame ("Running", "Waiting for your daily limit. Continues at 3:00 AM.", ...). */
export function statusText(frame) {
  const status = frame?.status || {};
  switch (status.state) {
    case 'planning': return t('abd.status.planning');
    case 'waiting': {
      const key = WAIT_KEYS[status.reason];
      return key ? t(key, { time: status.untilMs ? formatResumeTime(status.untilMs) : '' }) : t('abd.status.running');
    }
    case 'paused': return t(PAUSE_KEYS[status.reason] || PAUSE_KEYS.user);
    case 'completed': return t('abd.status.completed');
    case 'cancelled': return t('abd.status.cancelled');
    case 'failed': return t('abd.status.failed', { error: frame?.error || status.error || '' });
    default: return t('abd.status.running');
  }
}

/** The label of a folder row: Gmail's All Mail says what it stands for in this job. */
export function folderLabel(folder) {
  return folder.role === 'all_mail' ? t('settings.backup.abd.setup.allMailGmail') : mailboxLabel(folder.name || folder.path);
}
