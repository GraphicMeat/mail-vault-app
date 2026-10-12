import React, { useCallback, useEffect, useState } from 'react';
import { FileJson, Loader, Trash2 } from 'lucide-react';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { ConfirmDialog } from '../ConfirmDialog';
import { useT } from '../../i18n/index.js';
import { formatBytes } from '../../utils/formatBytes';
import { formatCount } from '../../utils/formatCount';
import * as storageFormat from '../../services/storageFormat';

const other = (format) => (format === 'jmap' ? 'maildir' : 'jmap');

/**
 * Settings > Storage > Message format: the vault's storage format, a
 * conversion to the other one, the old files a conversion set aside, and a
 * sweep of message blobs nothing names any more (in JMAP format, and in
 * Maildir format while a blob store is left: `blobs`).
 *
 * The daemon owns all of it; this renders what `storage_format_get` and the
 * `format-migration-progress` events say. The running conversion's corner
 * chip is Task 9's; here it gets Pause and Cancel, and once stopped, Resume
 * and Convert back. Convert remaining runs the same direction again, its
 * old-files choice picked anew: for a stopped run that left messages behind
 * (a delete-mode conflict only a retire-mode run settles), and for a vault
 * the daemon says still holds messages in the other format (`leftover`).
 * Hidden when the daemon cannot say (no vault, the web build).
 *
 * @param {{totalBytes?: number, emailCount?: number} | null} usage
 *   the vault's size (`maildir_storage_stats`), for the Convert dialog's estimate
 */
export function StorageFormatSettings({ usage }) {
  const t = useT();
  const [format, setFormat] = useState(null);
  const [migration, setMigration] = useState(null);
  const [retired, setRetired] = useState(null);
  const [blobs, setBlobs] = useState(false);
  const [leftover, setLeftover] = useState(false);
  const [convertOpen, setConvertOpen] = useState(false);
  // What the open dialog converts to: the other format, or this one again.
  const [convertTo, setConvertTo] = useState(null);
  const [oldFiles, setOldFiles] = useState('retire');
  const [purgeOpen, setPurgeOpen] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const [info, kept] = await Promise.all([storageFormat.get(), storageFormat.retired()]);
      setFormat(info?.format || 'maildir');
      setMigration(info?.migration || null);
      setBlobs(info?.blobs === true);
      setLeftover(info?.leftover === true);
      setRetired(kept || null);
    } catch (e) {
      console.warn('[storageFormat] state unavailable:', e?.message || e);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    const unlisteners = [];
    const keep = (p) => p.then((un) => { if (alive) unlisteners.push(un); else un?.(); });
    load();
    keep(storageFormat.onProgress((p) => {
      if (!alive) return;
      setMigration(p?.state === 'done' ? null : p);
      // An end changes the format, or what was set aside.
      if (p?.active === false) load();
    }));
    keep(storageFormat.onDaemonReconnected(() => { if (alive) load(); }));
    return () => {
      alive = false;
      unlisteners.forEach((un) => un?.());
    };
  }, [load]);

  if (!format) return null;

  const live = migration?.active === true;
  const stopped = migration && !live && (migration.state === 'cancelled' || migration.state === 'failed');
  const target = other(format);
  const dialogTo = convertTo || target;
  const formatName = (f) => (f === 'jmap' ? t('settings.storage.formatJmap') : t('settings.storage.formatMaildir'));

  // Every press of a control: one call, its refusal shown, the state read again.
  const act = async (call) => {
    if (working) return false;
    setWorking(true);
    setError(null);
    try {
      await call();
      await load();
      return true;
    } catch (e) {
      setError(storageFormat.errorMessage(e));
      // A refusal can change what the daemon says too (a stale leftover hint it took back).
      load();
      return false;
    } finally {
      setWorking(false);
    }
  };

  // `to`: the other format (Convert, Convert back), or this one again (Convert remaining).
  const openConvert = (to) => {
    setConvertTo(to);
    // Deleting is never carried over from an earlier open: it is picked each time.
    setOldFiles('retire');
    setError(null);
    setConvertOpen(true);
  };

  const startConversion = async () => {
    if (await act(() => storageFormat.convert(dialogTo, oldFiles))) setConvertOpen(false);
  };

  const purge = async () => {
    await act(() => storageFormat.purgeRetired());
    setPurgeOpen(false);
  };

  const retiredSize = formatBytes(retired?.bytes || 0);

  return (
    <div className="settings-section" data-testid="storage-format">
      <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
        <FileJson size={18} className="text-mail-accent-text" />
        {t('settings.storage.formatLabel')}
      </h4>

      <div className="space-y-4">
        <div className="flex items-center justify-between p-3 bg-mail-bg rounded-lg">
          <div className="pr-4">
            <div className="text-sm text-mail-text" data-testid="storage-format-current">{formatName(format)}</div>
            <div className="text-xs text-mail-text-muted">{t('settings.storage.formatHelp')}</div>
          </div>
          {!migration && (
            <Button variant="subtle" size="sm" className="shrink-0" onClick={() => openConvert(target)} disabled={working}>
              {t('settings.storage.convert')}
            </Button>
          )}
        </div>

        {!migration && leftover && (
          <div className="flex items-center justify-between p-3 bg-mail-bg rounded-lg">
            <div className="pr-4 text-sm text-mail-text" data-testid="storage-format-leftover">
              {t('settings.storage.leftover', { format: formatName(target) })}
            </div>
            <Button variant="subtle" size="sm" className="shrink-0" onClick={() => openConvert(format)} disabled={working}>
              {t('settings.storage.convertRemaining')}
            </Button>
          </div>
        )}

        {migration && (
          <div className="flex items-center justify-between p-3 bg-mail-bg rounded-lg" data-testid="storage-format-migration">
            <div className="pr-4 text-sm text-mail-text">
              <div>
                {stopped
                  ? t('settings.storage.convertStopped', { done: formatCount(migration.done || 0), total: formatCount(migration.total || 0) })
                  : t('settings.storage.converting', { done: formatCount(migration.done || 0), total: formatCount(migration.total || 0) })}
              </div>
              {migration.state === 'failed' && (
                <div className="text-xs text-mail-danger">
                  {t('errors.formatFailed', { reason: storageFormat.failureText(migration.error) })}
                </div>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {migration.state === 'running' && (
                <Button variant="secondary" size="sm" onClick={() => act(storageFormat.pause)} disabled={working}>
                  {t('settings.storage.convertPause')}
                </Button>
              )}
              {migration.state !== 'running' && (
                <Button variant="accentTint" size="sm" onClick={() => act(storageFormat.resume)} disabled={working}>
                  {t('common.resume')}
                </Button>
              )}
              {stopped && migration.failed > 0 && (
                <Button variant="subtle" size="sm" onClick={() => openConvert(format)} disabled={working}>
                  {t('settings.storage.convertRemaining')}
                </Button>
              )}
              {stopped ? (
                <Button variant="subtle" size="sm" onClick={() => openConvert(target)} disabled={working}>
                  {t('settings.storage.convertBack')}
                </Button>
              ) : (
                <Button variant="secondary" size="sm" onClick={() => act(storageFormat.cancel)} disabled={working}>
                  {t('common.cancel')}
                </Button>
              )}
            </div>
          </div>
        )}

        {retired?.count > 0 && (
          <div className="flex items-center justify-between p-3 bg-mail-bg rounded-lg">
            <div className="pr-4 text-sm text-mail-text" data-testid="storage-format-retired">
              {t('settings.storage.retiredSize', { size: retiredSize })}
            </div>
            <Button variant="dangerTint" size="sm" className="shrink-0" onClick={() => setPurgeOpen(true)} disabled={working || live}>
              <Trash2 size={14} />
              {t('settings.storage.retiredDelete')}
            </Button>
          </div>
        )}

        {(format === 'jmap' || blobs) && !live && (
          <div>
            <Button variant="subtle" size="sm" onClick={() => act(storageFormat.reclaimSpace)} disabled={working}>
              {working ? <Loader size={14} className="animate-spin" /> : null}
              {t('settings.storage.reclaim')}
            </Button>
          </div>
        )}

        {error && !convertOpen && (
          <p role="alert" className="text-xs text-mail-danger px-1">{error}</p>
        )}
      </div>

      <Dialog
        open={convertOpen}
        onClose={() => { if (!working) setConvertOpen(false); }}
        dismissable={!working}
        title={dialogTo === format
          ? t('settings.storage.convertRemainingTitle', { format: formatName(format) })
          : t('settings.storage.convertTitle', { format: formatName(dialogTo) })}
        footer={(
          <>
            <Button variant="secondary" size="lg" className="flex-1" onClick={() => setConvertOpen(false)} disabled={working} data-autofocus>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" size="lg" className="flex-1" onClick={startConversion} disabled={working}>
              {working ? <Loader size={14} className="animate-spin" /> : null}
              {t('settings.storage.convertStart')}
            </Button>
          </>
        )}
      >
        <p className="text-sm text-mail-text-muted">{t('settings.storage.formatHelp')}</p>
        {usage && (
          <div className="text-xs text-mail-text-muted">
            <div>{t('settings.storage.localStorageUsage')}</div>
            <div data-testid="storage-format-estimate">
              {formatBytes(usage.totalBytes || 0)}
              {' '}{t('settings.storage.emailsSavedParen', { count: formatCount(usage.emailCount || 0) })}
            </div>
          </div>
        )}
        <div className="space-y-2" role="radiogroup">
          <label className="flex items-start gap-2 text-sm text-mail-text cursor-pointer">
            <input
              type="radio"
              name="storage-format-old-files"
              value="retire"
              checked={oldFiles === 'retire'}
              onChange={() => setOldFiles('retire')}
              className="mt-0.5"
            />
            <span>{t('settings.storage.oldFilesRetire')}</span>
          </label>
          <label className="flex items-start gap-2 text-sm text-mail-text cursor-pointer">
            <input
              type="radio"
              name="storage-format-old-files"
              value="delete"
              checked={oldFiles === 'delete'}
              onChange={() => setOldFiles('delete')}
              className="mt-0.5"
            />
            <span>{t('settings.storage.oldFilesDelete')}</span>
          </label>
        </div>
        {error && <p role="alert" className="text-xs text-mail-danger">{error}</p>}
      </Dialog>

      <ConfirmDialog
        isOpen={purgeOpen}
        onClose={() => { if (!working) setPurgeOpen(false); }}
        onConfirm={purge}
        title={t('settings.storage.retiredDelete')}
        description={t('settings.storage.retiredConfirm', { size: retiredSize })}
        confirmLabel={t('settings.storage.deletePermanently')}
        cancelLabel={t('common.cancel')}
        destructive
        loading={working}
      />
    </div>
  );
}
