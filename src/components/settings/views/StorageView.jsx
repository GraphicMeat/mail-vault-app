// Settings > Storage as a view: where the mail is kept (Storage Status), how much of it stays on
// this device (the download card: desktop's download modes, the phone's offline window per
// account) with what it takes (Local storage usage), and the search index. What only one app has
// comes in as nodes:
// - `statusNote`: the Storage Status paragraph (desktop's by default; `null` leaves it out);
// - `downloadTitle`, `download`: the download card's heading (desktop's "Download mode" by
//   default) and its controls; `usage`: the usage line; `usageExtras`: rows after it;
// - `beforeSearchIndex`, `searchIndex`, `children`: the sections that follow, in that order.
import React from 'react';
import { Database, HardDrive } from 'lucide-react';
import { SettingsPageLayout } from '../../ui/SettingsForm';
import { useT } from './viewContext';

/** One row of the usage list: a label (and an optional hint) over its value. */
export function StorageUsageRow({ label, value, hint = null, valueClassName = 'text-xs text-mail-local', ...rest }) {
  return (
    <div className="flex items-center justify-between p-3 bg-mail-bg rounded-lg" {...rest}>
      <div>
        <div className="text-sm text-mail-text">{label}</div>
        {hint && <div className="text-xs text-mail-text-muted">{hint}</div>}
        {value != null && <div className={valueClassName}>{value}</div>}
      </div>
    </div>
  );
}

export function StorageView({
  statusNote, downloadTitle, download = null, usage, usageExtras = null, beforeSearchIndex = null, searchIndex = null, children = null,
}) {
  const t = useT();
  const note = statusNote === undefined ? t('settings.storage.ordinaryFilesNothingUploaded') : statusNote;
  return (
    <SettingsPageLayout>
      {/* Current Storage Status */}
      <div className="settings-section">
        <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
          <Database size={18} className="text-mail-accent-text" />
          {t('settings.storage.storageStatus')}
        </h4>

        <div className={`flex items-center gap-3 p-3 bg-mail-local-tint border border-mail-local/20 rounded-lg${note ? ' mb-4' : ''}`}>
          <div className="w-3 h-3 bg-mail-success rounded-full" />
          <span className="text-sm text-mail-text">
            {t('settings.storage.emailsStoredSecurelyLocalStorage')}
          </span>
        </div>

        {note && (
          <p className="text-sm text-mail-text-muted">
            {note}
          </p>
        )}
      </div>

      {/* Download mode: how much mail stays on this device */}
      <div className="settings-section">
        <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
          <HardDrive size={18} className="text-mail-accent-text" />
          {downloadTitle ?? t('settings.storage.downloadMode')}
        </h4>

        <div className="space-y-4">
          {download}

          {/* Local storage usage */}
          <StorageUsageRow label={t('settings.storage.localStorageUsage')} value={usage} />

          {usageExtras}
        </div>
      </div>

      {beforeSearchIndex}

      {searchIndex}

      {children}
    </SettingsPageLayout>
  );
}
