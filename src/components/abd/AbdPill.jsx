import React from 'react';
import { motion } from 'framer-motion';
import { Archive } from 'lucide-react';
import { useAbdStore, selectPanelJob } from '../../stores/abdStore';
import { isFinished, isStalled, pillPercent } from '../../utils/abdFrame';
import { statusText } from './abdText';
import { useT } from '../../i18n/index.js';

/**
 * A minimized Archive & delete job, in the corner stack the compose bubbles and
 * the Settings bubble share (App.jsx). A click brings the panel back. The job
 * itself runs in the daemon whether this is shown or not.
 */
export function AbdPill() {
  const t = useT();
  const minimized = useAbdStore(s => !!s.panel?.minimized);
  const job = useAbdStore(selectPanelJob);
  if (!minimized || !job) return null;

  const text = isFinished(job) ? statusText(job)
    : isStalled(job) ? t('abd.pillWaiting')
      : t('abd.pill', { percent: pillPercent(job) });

  return (
    <motion.div
      data-testid="abd-pill"
      data-state={job.status?.state}
      initial={{ x: 100, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 100, opacity: 0 }}
      className="flex items-center rounded-lg bg-mail-surface border border-mail-strong hover:bg-mail-surface-hover transition-colors max-w-[280px]"
    >
      <button type="button" data-testid="abd-pill-restore" onClick={() => useAbdStore.getState().restore()}
        className="flex items-center gap-2 px-3 py-2 min-w-0 text-left">
        <span className="w-7 h-7 rounded-full bg-mail-accent/20 flex items-center justify-center flex-shrink-0">
          <Archive size={14} className="text-mail-accent-text" aria-hidden="true" />
        </span>
        <span className="text-xs font-medium text-mail-text truncate">{text}</span>
      </button>
    </motion.div>
  );
}
