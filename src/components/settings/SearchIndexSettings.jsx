import React, { useEffect, useState } from 'react';
import { Search } from 'lucide-react';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ConfirmDialog';
import { ToggleSwitch } from './ToggleSwitch';
import { useSettingsStore, hasPremiumAccess } from '../../stores/settingsStore';
import { status, rebuild, destroy, onProgress } from '../../services/searchIndex';
import { formatBytes } from '../../utils/formatBytes';
import { useT } from '../../i18n/index.js';

export function SearchIndexSettings({ onUpgrade }) {
  const t = useT();
  const billingProfile = useSettingsStore(s => s.billingProfile);
  const savedConcurrency = useSettingsStore(s => s.searchMailboxConcurrency);
  const setSearchMailboxConcurrency = useSettingsStore(s => s.setSearchMailboxConcurrency);
  const isPremium = hasPremiumAccess(billingProfile);
  const concurrency = isPremium ? savedConcurrency : 1;
  const bodies = useSettingsStore(s => s.searchIndexBodies);
  const setSearchIndexBodies = useSettingsStore(s => s.setSearchIndexBodies);
  const attachments = useSettingsStore(s => s.searchIndexAttachments);
  const setSearchIndexAttachments = useSettingsStore(s => s.setSearchIndexAttachments);
  const imageText = useSettingsStore(s => s.searchIndexImageText);
  const setSearchIndexImageText = useSettingsStore(s => s.setSearchIndexImageText);
  const enabled = useSettingsStore(s => s.searchIndexEnabled !== false);
  const setSearchIndexEnabled = useSettingsStore(s => s.setSearchIndexEnabled);
  const [info, setInfo] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    let unlisten = null;
    onProgress(p => { if (alive) setInfo(p); }).then(u => { if (alive) unlisten = u; else u(); });
    // A progress event that beat the status reply is the newer of the two.
    status().then(s => { if (alive) setInfo(cur => cur ?? s); });
    return () => { alive = false; unlisten?.(); };
  }, []);

  const indexing = info?.available && info.state === 'indexing';
  const pct = info?.total > 0 ? Math.floor((100 * info.indexed) / info.total) : 0;

  const deleteIndex = async () => {
    setDeleting(true);
    setError(null);
    setSearchIndexEnabled(false); // spec §5.5: off first, so a restart never rebuilds what is being deleted
    try {
      const reply = await destroy();
      if (!reply?.ok) {
        const key = reply?.error || 'searchIndex.destroyFailed';
        if (key === 'searchIndex.busy') setSearchIndexEnabled(true); // nothing was deleted
        setError(key);
      }
    } catch (e) {
      // unreachable or died mid-request: keep indexing on; a partly deleted index rebuilds
      setSearchIndexEnabled(true);
      setError(e?.message || 'errors.daemonUnavailable');
    } finally {
      setDeleting(false);
      setConfirming(false);
    }
  };

  return (
    <div className="settings-section" id="settings-search-index">
      <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
        <Search size={18} className="text-mail-accent-text" />
        {t('settings.searchIndex.title')}
      </h4>
      <p className="text-sm text-mail-text-muted mb-4">{t('settings.searchIndex.description')}</p>

      <div className="space-y-4">
        <div className="flex items-center justify-between gap-4 p-3 bg-mail-bg rounded-lg">
          <div>
            <div className="text-sm text-mail-text">{t('settings.searchIndex.bodies')}</div>
            <div className="text-xs text-mail-text-muted">{t('settings.searchIndex.bodiesHint')}</div>
          </div>
          <ToggleSwitch active={bodies} onClick={() => setSearchIndexBodies(!bodies)}
            testId="search-index-bodies" label={t('settings.searchIndex.bodies')} />
        </div>

        <div className="flex items-center justify-between gap-4 p-3 bg-mail-bg rounded-lg">
          <div>
            <div className="text-sm text-mail-text">{t('settings.searchIndex.attachments')}</div>
            <div className="text-xs text-mail-text-muted">{t('settings.searchIndex.attachmentsHint')}</div>
          </div>
          <ToggleSwitch active={attachments} onClick={() => setSearchIndexAttachments(!attachments)}
            testId="search-index-attachments" label={t('settings.searchIndex.attachments')} />
        </div>

        <div className="flex items-center justify-between gap-4 p-3 bg-mail-bg rounded-lg">
          <div>
            <div className="text-sm text-mail-text">{t('settings.searchIndex.imageText')}</div>
            <div className="text-xs text-mail-text-muted">{t('settings.searchIndex.imageTextHint')}</div>
          </div>
          <ToggleSwitch active={imageText} onClick={() => setSearchIndexImageText(!imageText)}
            testId="search-index-image-text" label={t('settings.searchIndex.imageText')} />
        </div>

        <div className="flex items-center justify-between gap-4 p-3 bg-mail-bg rounded-lg">
          <div className="min-w-0">
            <div className="text-sm text-mail-text">{t('settings.searchIndex.concurrency')}</div>
            <div className="text-xs text-mail-text-muted">
              {t(isPremium ? 'settings.searchIndex.concurrencyHint' : 'settings.searchIndex.concurrencyFree')}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <select
              data-testid="search-mailbox-concurrency"
              aria-label={t('settings.searchIndex.concurrency')}
              value={concurrency}
              disabled={!isPremium}
              onChange={e => setSearchMailboxConcurrency(Number(e.target.value))}
              className="rounded-lg border border-mail-border bg-mail-surface px-3 py-1.5 text-sm text-mail-text disabled:opacity-70"
            >
              {[1, 2, 3, 4, 5].map(n => <option key={n} value={n}>{n}</option>)}
            </select>
            {!isPremium && onUpgrade && (
              <Button size="sm" variant="primary" data-testid="search-concurrency-upgrade" onClick={onUpgrade}>
                {t('search.fallback.upgrade')}
              </Button>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between gap-4 p-3 bg-mail-bg rounded-lg">
          {enabled ? (
            <>
              <div className="flex-1 min-w-0">
                {info?.available ? (
                  <>
                    <div className="text-sm text-mail-text" data-testid="search-index-status">
                      {t('settings.searchIndex.status', {
                        indexed: (info.indexed || 0).toLocaleString(),
                        total: (info.total || 0).toLocaleString(),
                        size: formatBytes(info.sizeBytes || 0),
                      })}
                    </div>
                    {indexing && (
                      <>
                        <div className="text-xs text-mail-text-muted">{t('settings.searchIndex.indexing')}</div>
                        <div role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}
                          aria-label={t('settings.searchIndex.indexing')}
                          className="h-1.5 rounded-full bg-mail-border mt-2 overflow-hidden">
                          <div className="h-1.5 rounded-full bg-mail-accent transition-all" style={{ width: `${pct}%` }} />
                        </div>
                      </>
                    )}
                  </>
                ) : info && (
                  <div className="text-xs text-mail-text-muted">{t(info.error === 'errors.daemonOutdated' ? 'errors.daemonOutdated' : 'settings.searchIndex.unavailable')}</div>
                )}
              </div>
              <div className="flex gap-2">
                <Button size="sm" data-testid="search-index-rebuild" disabled={!info?.available}
                  onClick={() => rebuild().catch(e => console.warn('[searchIndex] rebuild failed:', e))}>
                  {t('settings.searchIndex.rebuild')}
                </Button>
                <Button size="sm" variant="dangerTint" data-testid="search-index-delete"
                  disabled={deleting || !info?.available}
                  onClick={() => setConfirming(true)}>
                  {t('settings.searchIndex.delete')}
                </Button>
              </div>
            </>
          ) : (
            <>
              <div className="text-xs text-mail-text-muted" data-testid="search-index-off">
                {t('settings.searchIndex.off')}
              </div>
              <Button size="sm" data-testid="search-index-build"
                onClick={() => { setError(null); setSearchIndexEnabled(true); }}>
                {t('settings.searchIndex.build')}
              </Button>
            </>
          )}
        </div>
        {error && (
          <div className="text-xs text-mail-danger mt-2" role="alert" data-testid="search-index-error">
            {t(error)}
          </div>
        )}
      </div>

      <ConfirmDialog
        isOpen={confirming}
        onClose={() => !deleting && setConfirming(false)}
        onConfirm={deleteIndex}
        title={t('settings.searchIndex.deleteConfirmTitle')}
        description={t('settings.searchIndex.deleteConfirmBody', { size: formatBytes(info?.sizeBytes || 0) })}
        confirmLabel={t('settings.searchIndex.deleteConfirm')}
        cancelLabel={t('common.cancel')}
        destructive
        loading={deleting}
      />
    </div>
  );
}
