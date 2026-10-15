import React, { useState } from 'react';
import { EyeOff, ChevronDown, Check } from 'lucide-react';
import { useSettingsStore } from '../stores/settingsStore';
import { useViewStore, viewLabel } from '../stores/viewStore';
import { Dialog } from './ui/Dialog';
import { Button } from './ui/Button';
import { useT } from '../i18n';

/// "Hide view mail" in the list toolbar. Never picked, it is one button that
/// opens the picker. Once picked it is split for good: the left half turns the
/// hide on and off, the right half reopens the picker. A pick that holds no
/// existing view leaves the left half inactive: there is nothing to hide.
export function HideViewMailButton() {
  const t = useT();
  const views = useViewStore(s => s.views);
  const hideViewMail = useSettingsStore(s => s.hideViewMail);
  const picked = useSettingsStore(s => s.hideViewMailViews);
  const setHideViewMail = useSettingsStore(s => s.setHideViewMail);
  const setPicked = useSettingsStore(s => s.setHideViewMailViews);
  const [draft, setDraft] = useState(null);

  const configured = Array.isArray(picked);
  // A deleted view's id stays in the pick but holds nothing.
  const live = configured && views.some(view => picked.includes(view.id));
  const on = !!hideViewMail && live;

  const open = () => {
    setDraft(new Set(configured ? picked : []));
    // A view made in the Settings window since this one loaded its list must
    // be pickable. A failed ask keeps the list it has.
    useViewStore.getState().loadViews().catch(() => {});
  };
  const close = () => setDraft(null);
  const flip = id => setDraft(current => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const apply = () => {
    // Saved in the views' order, and only views that still exist.
    const ids = views.map(view => view.id).filter(id => draft.has(id));
    setPicked(ids);
    setHideViewMail(ids.length > 0);
    close();
  };

  const picker = (
    <Dialog open={draft !== null} onClose={close} portal title={t('list.hideViewMailPickTitle')}
      description={t('list.hideViewMailPickHint')} data-testid="hide-view-mail-modal"
      footer={<>
        <Button variant="secondary" onClick={close}>{t('common.cancel')}</Button>
        <Button variant="primary" data-testid="hide-view-mail-ok" onClick={apply}>{t('list.hideViewMailOk')}</Button>
      </>}>
      <div className="flex flex-wrap gap-2" role="group" aria-label={t('list.hideViewMailPickTitle')}>
        {views.map(view => {
          const chosen = !!draft?.has(view.id);
          return (
            <Button key={view.id} size="sm" pill variant={chosen ? 'accentTint' : 'secondary'}
              data-testid="hide-view-mail-pick" data-view-id={view.id} aria-pressed={chosen}
              onClick={() => flip(view.id)}>
              {chosen && <Check size={14} aria-hidden="true" />}{viewLabel(view, t)}
            </Button>
          );
        })}
      </div>
    </Dialog>
  );

  if (!configured) {
    return (
      <>
        <button type="button" data-testid="hide-view-mail-config" className="mail-toolbar-button"
          aria-label={t('list.hideViewMail')} title={t('list.hideViewMailOff')} onClick={open}>
          <EyeOff size={14} />
        </button>
        {picker}
      </>
    );
  }

  return (
    <>
      <div className="mail-split-button" data-testid="hide-view-mail-split" role="group" aria-label={t('list.hideViewMail')}>
        <button type="button" data-testid="hide-view-mail-toggle" className={`mail-toolbar-button ${on ? 'is-active' : ''}`}
          aria-pressed={on} aria-label={t('list.hideViewMail')} disabled={!live}
          title={!live ? t('list.hideViewMailNone') : on ? t('list.hideViewMailOn') : t('list.hideViewMailOff')}
          onClick={() => setHideViewMail(!on)}><EyeOff size={14} /></button>
        <button type="button" data-testid="hide-view-mail-config" className="mail-toolbar-button"
          aria-label={t('list.hideViewMailConfigure')} title={t('list.hideViewMailConfigure')} onClick={open}>
          <ChevronDown size={12} />
        </button>
      </div>
      {picker}
    </>
  );
}
