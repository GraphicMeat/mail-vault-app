import React, { useEffect, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ConfirmDialog';
import { ToggleSwitch } from './ToggleSwitch';
import { useSettingsStore, hasPremiumAccess } from '../../stores/settingsStore';
import { status, rebuild, destroy, onProgress, onDaemonReconnected } from '../../services/searchIndex';
import { formatBytes } from '../../utils/formatBytes';
import { useT } from '../../i18n/index.js';
import { formatCount } from '../../utils/formatCount';

const PREMIUM_MARKER = '\uE000premium\uE001';

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
  const [error, setError] = useState(null);
  const lifecycleRef = useRef(null);
  const deleteInFlight = useRef(false);
  const rebuildInFlight = useRef(false);

  const isCurrentLifecycle = lifecycle => lifecycle?.active && lifecycleRef.current === lifecycle;
  const refreshStatus = (lifecycle, options) => isCurrentLifecycle(lifecycle)
    ? lifecycle.refreshStatus(options)
    : Promise.resolve(null);

  useEffect(() => {
    const lifecycle = {
      active: true,
      progressVersion: 0,
      statusSequence: 0,
      refreshStatus: null,
      unlistenProgress: null,
      unlistenReconnect: null,
    };
    lifecycleRef.current = lifecycle;
    const isActive = () => lifecycle.active && lifecycleRef.current === lifecycle;
    const refresh = ({ preserveActionError = false } = {}) => {
      if (!isActive()) return Promise.resolve(null);
      const requestSequence = ++lifecycle.statusSequence;
      const progressVersion = lifecycle.progressVersion;
      return status().then(next => {
        if (!isActive() || requestSequence !== lifecycle.statusSequence || progressVersion !== lifecycle.progressVersion) return next;
        setInfo(next);
        if (!preserveActionError && next?.available && next.state !== 'error' && !next.errorKey && !next.error) setError(null);
        return next;
      });
    };
    lifecycle.refreshStatus = refresh;
    const handleProgress = next => {
      if (!isActive()) return;
      lifecycle.progressVersion += 1;
      lifecycle.statusSequence += 1;
      setInfo(next);
      if (next?.available && next.state !== 'error' && !next.errorKey && !next.error) setError(null);
    };
    onProgress(handleProgress).then(unlisten => {
      if (isActive()) lifecycle.unlistenProgress = unlisten;
      else unlisten?.();
    });
    onDaemonReconnected(refresh).then(unlisten => {
      if (isActive()) lifecycle.unlistenReconnect = unlisten;
      else unlisten?.();
    });
    refresh();
    return () => {
      lifecycle.active = false;
      lifecycle.statusSequence += 1;
      lifecycle.unlistenProgress?.();
      lifecycle.unlistenReconnect?.();
      if (lifecycleRef.current === lifecycle) lifecycleRef.current = null;
    };
  }, []);

  const indexing = info?.available && !info.errorKey && !info.error && info.state === 'indexing';
  const pct = info?.total > 0 ? Math.floor((100 * info.indexed) / info.total) : 0;
  const premiumLabel = t('common.premium');

  const renderPremiumHint = key => {
    const text = t(key, { premium: PREMIUM_MARKER });
    const parts = text.split(PREMIUM_MARKER);
    return parts.map((part, index) => (
      <React.Fragment key={`${key}-${index}`}>
        {part}
        {index < parts.length - 1 && (onUpgrade ? (
          <button
            type="button"
            data-testid="search-index-premium-link"
            aria-label={premiumLabel}
            onClick={onUpgrade}
            className="inline cursor-pointer p-0 text-mail-accent-text underline underline-offset-2 hover:text-mail-accent-hover"
          >
            {premiumLabel}
          </button>
        ) : premiumLabel)}
      </React.Fragment>
    ));
  };

  const rebuildIndex = async () => {
    if (rebuildInFlight.current) return;
    const lifecycle = lifecycleRef.current;
    if (!isCurrentLifecycle(lifecycle)) return;
    rebuildInFlight.current = true;
    lifecycle.statusSequence += 1;
    setError(null);
    setSearchIndexEnabled(true);
    try {
      const reply = await rebuild();
      if (reply?.ok === false && isCurrentLifecycle(lifecycle)) setError(reply.error || 'searchIndex.recoveryFailed');
    } catch (e) {
      if (isCurrentLifecycle(lifecycle)) setError(e?.code === 'DAEMON_OUTDATED' ? 'errors.daemonOutdated' : (e?.message || 'errors.daemonUnavailable'));
    } finally {
      refreshStatus(lifecycle, { preserveActionError: true });
      rebuildInFlight.current = false;
    }
  };

  // The daemon's destroy is a background job: its worker finishes the current
  // batch or compaction first (up to two minutes). Waiting on that reply is
  // what the user saw as an endless loader, so the modal closes on the click
  // and the outcome arrives as status/error afterwards.
  const deleteIndex = () => {
    setConfirming(false);
    if (deleteInFlight.current) return;
    const lifecycle = lifecycleRef.current;
    if (!isCurrentLifecycle(lifecycle)) return;
    deleteInFlight.current = true;
    lifecycle.statusSequence += 1;
    setError(null);
    const wasEnabled = useSettingsStore.getState().searchIndexEnabled !== false;
    setSearchIndexEnabled(false);
    destroy().then(
      reply => {
        if (reply?.ok) return;
        if (reply?.error === 'searchIndex.busy') setSearchIndexEnabled(wasEnabled);
        if (isCurrentLifecycle(lifecycle)) setError(reply?.error || 'searchIndex.destroyFailed');
      },
      e => {
        setSearchIndexEnabled(wasEnabled);
        if (isCurrentLifecycle(lifecycle)) setError(e?.code === 'DAEMON_OUTDATED' ? 'errors.daemonOutdated' : (e?.message || 'errors.daemonUnavailable'));
      },
    ).then(() => {
      refreshStatus(lifecycle, { preserveActionError: true });
      deleteInFlight.current = false;
    });
  };

  const statusErrorKey = info?.errorKey || info?.error;
  const hasStatusError = !!statusErrorKey || info?.state === 'error';
  const statusMessage = statusErrorKey
    ? t(statusErrorKey)
    : info?.state === 'starting'
      ? t('settings.searchIndex.starting')
      : info?.state === 'error'
        ? t('searchIndex.recoveryFailed')
        : t('settings.searchIndex.recovering');
  const errorDetail = info?.errorDetail;

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
          <ToggleSwitch active={enabled && bodies} disabled={!enabled} onClick={() => setSearchIndexBodies(!bodies)}
            testId="search-index-bodies" label={t('settings.searchIndex.bodies')} />
        </div>

        <div className="flex items-center justify-between gap-4 p-3 bg-mail-bg rounded-lg">
          <div>
            <div className="text-sm text-mail-text">{t('settings.searchIndex.attachments')}</div>
            <div className="text-xs text-mail-text-muted">{renderPremiumHint('settings.searchIndex.attachmentsHint')}</div>
          </div>
          <ToggleSwitch active={enabled && attachments} disabled={!enabled} onClick={() => setSearchIndexAttachments(!attachments)}
            testId="search-index-attachments" label={t('settings.searchIndex.attachments')} />
        </div>

        <div className="flex items-center justify-between gap-4 p-3 bg-mail-bg rounded-lg">
          <div>
            <div className="text-sm text-mail-text">{t('settings.searchIndex.imageText')}</div>
            <div className="text-xs text-mail-text-muted">{renderPremiumHint('settings.searchIndex.imageTextHint')}</div>
          </div>
          <ToggleSwitch active={enabled && imageText} disabled={!enabled} onClick={() => setSearchIndexImageText(!imageText)}
            testId="search-index-image-text" label={t('settings.searchIndex.imageText')} />
        </div>

        <div className="flex items-center justify-between gap-4 p-3 bg-mail-bg rounded-lg">
          <div className="min-w-0">
            <div className="text-sm text-mail-text">{t('settings.searchIndex.concurrency')}</div>
            <div className="text-xs text-mail-text-muted">
              {renderPremiumHint(isPremium ? 'settings.searchIndex.concurrencyHint' : 'settings.searchIndex.concurrencyFree')}
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
          <div className="flex-1 min-w-0">
            {!enabled && !hasStatusError ? (
              <div className="text-xs text-mail-text-muted" data-testid="search-index-off">
                {t('settings.searchIndex.off')}
              </div>
            ) : info?.available && !hasStatusError ? (
              <>
                <div className="text-sm text-mail-text" data-testid="search-index-status">
                  {t('settings.searchIndex.status', {
                    indexed: formatCount(info.indexed || 0),
                    total: formatCount(info.total || 0),
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
              <div className="text-xs text-mail-text-muted" data-testid="search-index-status-message" role={statusErrorKey ? 'alert' : undefined}>
                <span>{statusMessage}</span>
                {errorDetail && errorDetail !== statusMessage && errorDetail !== statusErrorKey && (
                  <span>{` ${errorDetail}`}</span>
                )}
              </div>
            )}
          </div>
          <div className="flex gap-2">
            {enabled ? (
              <Button size="sm" data-testid="search-index-rebuild" onClick={rebuildIndex}>
                {t('settings.searchIndex.rebuild')}
              </Button>
            ) : (
              <Button size="sm" data-testid="search-index-build" onClick={rebuildIndex}>
                {t('settings.searchIndex.build')}
              </Button>
            )}
            <Button size="sm" variant="dangerTint" data-testid="search-index-delete"
              onClick={() => setConfirming(true)}>
              {t('settings.searchIndex.delete')}
            </Button>
          </div>
        </div>
        {error && (
          <div className="text-xs text-mail-danger mt-2" role="alert" data-testid="search-index-error">
            {t(error)}
          </div>
        )}
      </div>

      <ConfirmDialog
        isOpen={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={deleteIndex}
        title={t('settings.searchIndex.deleteConfirmTitle')}
        description={t('settings.searchIndex.deleteConfirmBody', { size: formatBytes(info?.sizeBytes || 0) })}
        confirmLabel={t('settings.searchIndex.deleteConfirm')}
        cancelLabel={t('common.cancel')}
        destructive
      />
    </div>
  );
}
