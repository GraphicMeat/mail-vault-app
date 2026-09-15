import React, { useEffect, useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import { Dialog } from './ui/Dialog';
import { ToastShell } from './ui/ToastShell';
import { Button } from './ui/Button';
import { useT } from '../i18n/index.js';
import { formatBytes } from '../utils/formatBytes';
import { status, onProgress, onDaemonReconnected } from '../services/searchIndex';
import { wantsProgressUi, buildFinished, progressPercent, OPEN_DELAY_MS } from '../utils/searchIndexProgress';

/** Progress of a big index pass (first build, rebuild, backlog >= 500): a dismissable modal, minimized to a chip. */
export function SearchIndexProgress() {
  const t = useT();
  const [info, setInfo] = useState(null);
  const [shown, setShown] = useState(false);
  const [hidden, setHidden] = useState(false); // in memory only: a relaunch mid-build shows the modal again

  useEffect(() => {
    let alive = true;
    const unlisteners = [];
    const keep = (p) => p.then((un) => { if (alive) unlisteners.push(un); else un?.(); });
    keep(onProgress((p) => { if (alive) setInfo(p); }));
    const refresh = () => status().then((s) => { if (alive) setInfo(s); });
    keep(onDaemonReconnected(refresh));
    status().then((s) => { if (alive) setInfo((cur) => cur ?? s); });
    return () => { alive = false; unlisteners.forEach((un) => un?.()); };
  }, []);

  const wanted = wantsProgressUi(info);
  useEffect(() => {
    if (!wanted) { setShown(false); return undefined; }
    const timer = setTimeout(() => setShown(true), OPEN_DELAY_MS);
    return () => clearTimeout(timer);
  }, [wanted]);

  const finished = buildFinished(info);
  useEffect(() => { if (finished) setHidden(false); }, [finished]);

  if (!shown || !wanted) return null;
  const percent = progressPercent(info);

  return (
    <>
      <Dialog
        open={!hidden}
        onClose={() => setHidden(true)}
        title={t('searchIndexProgress.title')}
        size="sm"
        data-testid="search-index-progress-modal"
        footer={<Button variant="secondary" data-testid="search-index-progress-hide" onClick={() => setHidden(true)}>{t('searchIndexProgress.hide')}</Button>}
      >
        <p className="text-sm text-mail-text-muted mb-3">{t('searchIndexProgress.body')}</p>
        <div role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} aria-label={t('searchIndexProgress.title')}
          className="h-2 rounded-full bg-mail-border overflow-hidden">
          <div className="h-2 rounded-full bg-mail-accent transition-all" style={{ width: `${percent}%` }} />
        </div>
        <div className="mt-2 flex justify-between text-xs text-mail-text-muted">
          <span>{t('searchIndexProgress.count', { indexed: (info.indexed || 0).toLocaleString('en-US'), total: (info.total || 0).toLocaleString('en-US'), percent })}</span>
          <span>{t('searchIndexProgress.size', { size: formatBytes(info.sizeBytes || 0) })}</span>
        </div>
      </Dialog>
      <AnimatePresence>
        {hidden && (
          <ToastShell position="bottom-right" className="cursor-pointer px-3 py-2 text-sm" data-testid="search-index-chip" onClick={() => setHidden(false)}>
            {t('searchIndexProgress.chip', { percent })}
          </ToastShell>
        )}
      </AnimatePresence>
    </>
  );
}
