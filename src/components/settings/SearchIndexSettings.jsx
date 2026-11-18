import React, { useEffect, useRef, useState } from 'react';
import { ConfirmDialog } from '../ConfirmDialog';
import { useSettingsStore, hasPremiumAccess } from '../../stores/settingsStore';
import { status, rebuild, destroy, onProgress, onDaemonReconnected } from '../../services/searchIndex';
import { formatBytes } from '../../utils/formatBytes';
import { useT } from '../../i18n/index.js';
import { DesktopViewEnv } from './DesktopViewEnv';
import { SearchIndexView } from './views/SearchIndexView';

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

  return (
    <DesktopViewEnv>
      <SearchIndexView enabled={enabled} bodies={bodies} attachments={attachments}
        onBodies={() => setSearchIndexBodies(!bodies)} onAttachments={() => setSearchIndexAttachments(!attachments)}
        imageText={{ value: imageText, onToggle: () => setSearchIndexImageText(!imageText) }}
        concurrency={{ value: concurrency, isPremium, onChange: setSearchMailboxConcurrency }}
        info={info} error={error} onRebuild={rebuildIndex} onDelete={() => setConfirming(true)} onUpgrade={onUpgrade}>
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
      </SearchIndexView>
    </DesktopViewEnv>
  );
}
