import React, { useEffect, useRef, useState } from 'react';
import { Hourglass } from 'lucide-react';
import { Dialog } from './ui/Dialog';
import { Button } from './ui/Button';
import { useViewStore } from '../stores/viewStore';
import { onProgress } from '../services/searchIndex';
import { useT } from '../i18n/index.js';

/**
 * Opening a saved view while the search index is being rebuilt finds nothing:
 * a view is a query against that index. Said once per rebuild, the first time
 * a view comes back "building", so an empty view does not read as a bug.
 *
 * Index progress itself stays the corner chip (SearchIndexProgress). This is
 * an explanation, asked for as a modal, and it never holds up the rebuild.
 * When the rebuild's first pass lands, the view still waiting on it is run
 * again, and the next rebuild may explain itself again.
 */
export function ViewsReindexNotice() {
  const t = useT();
  const activeViewId = useViewStore(s => s.activeViewId);
  const reason = useViewStore(s => s.unavailableReason);
  const [open, setOpen] = useState(false);
  const shownThisRun = useRef(false);

  useEffect(() => {
    if (!activeViewId || reason !== 'building' || shownThisRun.current) return;
    shownThisRun.current = true;
    setOpen(true);
  }, [activeViewId, reason]);

  useEffect(() => {
    let alive = true;
    let stop;
    onProgress((status) => {
      if (!status?.firstPassDone) return;
      shownThisRun.current = false;
      const views = useViewStore.getState();
      if (views.activeViewId && views.unavailableReason === 'building') void views.openView(views.activeViewId);
    }).then((un) => { if (alive) stop = un; else un?.(); });
    return () => { alive = false; stop?.(); };
  }, []);

  const close = () => setOpen(false);
  return (
    <Dialog
      open={open}
      onClose={close}
      size="sm"
      icon={<Hourglass size={20} className="text-mail-accent-text" aria-hidden="true" />}
      title={t('views.reindexNotice.title')}
      description={<>
        <p>{t('views.reindexNotice.body')}</p>
        <p className="mt-2">{t('views.reindexNotice.after')}</p>
      </>}
      data-testid="views-reindex-notice"
      footer={<Button variant="primary" data-autofocus data-testid="views-reindex-notice-ok" onClick={close}>
        {t('views.reindexNotice.ok')}
      </Button>}
    />
  );
}
