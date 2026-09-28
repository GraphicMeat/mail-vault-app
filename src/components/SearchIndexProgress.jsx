import React, { useEffect, useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import { Dialog } from './ui/Dialog';
import { ToastShell } from './ui/ToastShell';
import { Button } from './ui/Button';
import { useT } from '../i18n/index.js';
import { formatBytes } from '../utils/formatBytes';
import { status, onProgress, onDaemonReconnected } from '../services/searchIndex';
import { wantsProgressUi, buildFinished, progressPercent, OPEN_DELAY_MS } from '../utils/searchIndexProgress';
import { formatCount } from '../utils/formatCount';

/**
 * Progress of a big index pass (first build, rebuild, backlog >= 500): a corner chip that never blocks or
 * steals focus (background work must not disturb the UI). Clicking it opens the details modal.
 */
export function SearchIndexProgress() {
  const t = useT();
  const [info, setInfo] = useState(null);
  const [shown, setShown] = useState(false);
  const [hidden, setHidden] = useState(true); // the chip is the default; only a click opens the modal

  useEffect(() => {
    let alive = true;
    let progressCount = 0;
    const unlisteners = [];
    const keep = (p) => p.then((un) => { if (alive) unlisteners.push(un); else un?.(); });
    keep(onProgress((p) => { progressCount += 1; if (alive) setInfo(p); }));
    const refresh = () => {
      const before = progressCount;
      // A progress event landing while this RPC is in flight is newer than
      // whatever it resolves with: don't let a slow reply clobber it.
      status().then((s) => { if (alive && progressCount === before) setInfo(s); });
    };
    keep(onDaemonReconnected(refresh));
    status().then((s) => { if (alive) setInfo((cur) => cur ?? s); });
    return () => { alive = false; unlisteners.forEach((un) => un?.()); };
  }, []);

  const wanted = wantsProgressUi(info);
  const finished = buildFinished(info);
  // A folder finishing mid-build can flip `wanted` false for one batch even
  // though the pass overall is still running (review 1.10 I1: `total` can
  // momentarily equal a folder's own count). Once shown, ride out that blip
  // instead of the modal/chip vanishing and reappearing — only really leaving
  // `indexing`, or the whole build finishing, is a reason to drop it.
  const stillIndexing = !!info && info.state === 'indexing' && !finished;
  useEffect(() => {
    if (!wanted) {
      if (!stillIndexing) setShown(false);
      return undefined;
    }
    const timer = setTimeout(() => setShown(true), OPEN_DELAY_MS);
    return () => clearTimeout(timer);
  }, [wanted, stillIndexing]);

  useEffect(() => { if (finished) setHidden(true); }, [finished]);

  if (!shown || (!wanted && !stillIndexing)) return null;
  const percent = progressPercent(info);

  return (
    <>
      <Dialog
        open={!hidden}
        onClose={() => setHidden(true)}
        title={t('searchIndexProgress.title')}
        description={t('searchIndexProgress.body')}
        closeLabel={t('common.minimize')}
        size="sm"
        data-testid="search-index-progress-modal"
        footer={<Button variant="secondary" data-testid="search-index-progress-hide" onClick={() => setHidden(true)}>{t('searchIndexProgress.hide')}</Button>}
      >
        <div role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} aria-label={t('searchIndexProgress.title')}
          className="h-2 rounded-full bg-mail-border overflow-hidden">
          <div className="h-2 rounded-full bg-mail-accent transition-all" style={{ width: `${percent}%` }} />
        </div>
        <div className="mt-2 flex justify-between text-xs text-mail-text-muted">
          <span>{t('searchIndexProgress.count', { indexed: formatCount(info.indexed || 0), total: formatCount(info.total || 0), percent })}</span>
          <span>{t('searchIndexProgress.size', { size: formatBytes(info.sizeBytes || 0) })}</span>
        </div>
      </Dialog>
      <AnimatePresence>
        {hidden && (
          <ToastShell position="bottom-right" role="presentation" bare>
            <button
              type="button"
              data-testid="search-index-chip"
              className="bg-mail-surface border border-mail-border rounded-xl px-3 py-2 text-sm cursor-pointer"
              onClick={() => setHidden(false)}
            >
              {t('searchIndexProgress.chip', { percent })}
            </button>
          </ToastShell>
        )}
      </AnimatePresence>
    </>
  );
}
