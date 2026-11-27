import React, { useEffect, useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import { Trash2 } from 'lucide-react';
import { ToastShell } from './ui/ToastShell';
import { useT } from '../i18n/index.js';
import { formatCount } from '../utils/formatCount';
import { bulkOperationManager } from '../services/BulkOperationManager.js';

/** A burst of counts re-renders the chip at most this often. */
export const RENDER_EVERY_MS = 1000;

/**
 * Delete everywhere's rows leave the list at the click; the daemon then works
 * through the server, the vault and the backup drive for as long as that
 * takes. This corner chip says how far it is, never blocks, and goes when the
 * run settles (a failure is still said by its own toast). Other bulk runs
 * report in their own panel.
 */
export function DeleteEverywhereProgress() {
  const [run, setRun] = useState(null);

  useEffect(() => {
    let latest = null;
    let timer = null;
    let shown = false;
    const flush = () => { timer = null; setRun(latest); };
    const unsubscribe = bulkOperationManager.subscribe((op, { settled } = {}) => {
      if (op?.type !== 'delete_everywhere') return;
      if (settled) {
        clearTimeout(timer);
        timer = null;
        latest = null;
        shown = false;
        setRun(null);
        return;
      }
      latest = op;
      if (!shown) { shown = true; setRun(op); return; }
      if (!timer) timer = setTimeout(flush, RENDER_EVERY_MS);
    });
    return () => { clearTimeout(timer); unsubscribe(); };
  }, []);

  return (
    <AnimatePresence>
      {run && <Chip run={run} />}
    </AnimatePresence>
  );
}

function Chip({ run }) {
  const t = useT();
  const total = run.total || 0;
  const completed = Math.min(run.completed || 0, total);
  const percent = total > 0 ? Math.floor((completed * 100) / total) : 0;
  return (
    <ToastShell position="bottom-left" data-testid="delete-everywhere-chip" className="w-72 px-3 py-2.5 text-sm">
      <div className="flex items-center gap-2">
        <Trash2 size={14} className="text-mail-text-muted shrink-0" aria-hidden="true" />
        <span className="font-medium text-mail-text">{t('bulk.progress.deleting')}</span>
        <span className="ml-auto text-xs text-mail-text-muted tabular-nums">
          {t('bulk.progress.completedOfTotal', { completed: formatCount(completed), total: formatCount(total) })}
        </span>
      </div>
      <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}
        className="mt-2 h-1 rounded-full bg-mail-border overflow-hidden">
        <div className="h-full bg-mail-accent transition-[width] duration-300" style={{ width: `${percent}%` }} />
      </div>
    </ToastShell>
  );
}
