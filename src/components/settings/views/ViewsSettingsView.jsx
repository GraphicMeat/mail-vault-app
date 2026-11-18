// Settings > Views, as a view both apps render: the saved views in order (dragged or moved with
// the arrow keys), New, the free plan's cap and its upgrade, and the editor of the view picked
// (`children`). Desktop's container is ViewsSettings.jsx (the view and settings stores, the
// unsaved-changes prompt); the phone's is src/mobile/settings/Views.jsx (`mobile.views.*`).
//
// Props: `views`, `editingId` (the view whose editor is open), `premium`, `full` (no room for
// one more), `max` (the free plan's cap), `refused` (New was refused by the cap), `error` (a
// write that failed), `note` (a line under the list: the phone says it finds offline mail only),
// `upgradeLink` (desktop's premium features link), and `onNew()`, `onUpgrade()`,
// `onSelect(id)`, `onReorder(ids)`.
import React from 'react';
import { Plus } from 'lucide-react';
import { useT } from './viewContext';
import { viewLabel } from '../../../utils/viewLabel.js';
import { Button } from '../../ui/Button';
import { SettingsSection, SettingsPageLayout } from '../../ui/SettingsForm';
import { ViewIcon } from '../../ViewIcon';
import { ReorderListView } from './ReorderListView';

/// The views page: one list, one builder, and the builder previews what it
/// would find while it is being typed.
///
/// This is the only place a view's filters can be changed. The sidebar opens
/// views and nothing else — editing a filter from the mail screen meant
/// rewriting the list under the person reading it.
export function ViewsSettingsView({
  views = [], editingId = null, premium = false, full = false, max, refused = false, error = '', note = null,
  upgradeLink = null, onNew, onUpgrade, onSelect, onReorder, children,
}) {
  const t = useT();
  return <SettingsPageLayout as="section" spaced={false} className="views-settings" aria-label={t('views.section')}>
    <SettingsSection>
      <Button variant="secondary" size="sm" type="button" data-testid="views-new" disabled={full}
        aria-label={t('views.new')} onClick={onNew}><Plus size={14} /> {t('views.new')}</Button>

    {/* The cap is a fact about the plan, so it is stated before it bites, not
        only when the + refuses. Body-size text and a real button, the shape of
        every other upsell: a muted 12px line with a link at its end read as a
        footnote nobody was meant to act on. */}
    {!premium && <div className="views-upsell mt-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-mail-border bg-mail-surface p-4"
      data-testid="views-upsell">
      <p className="views-limit text-sm font-medium text-mail-text" data-testid="views-limit">
        {t('views.limit', { used: views.length, max })}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" size="sm" data-testid="views-upgrade" onClick={() => onUpgrade?.()}>
          {t('views.upgrade')}
        </Button>
        {upgradeLink}
      </div>
    </div>}

    {refused && <p className="views-refused text-xs" role="status" data-testid="views-refused">
      {t('views.limitReached', { max })}
    </p>}

    {error && <p className="text-sm text-mail-danger" role="alert">{error}</p>}

    <div className="views-list" data-testid="views-list">
      <ReorderListView accounts={views.map(view => ({ ...view, email: viewLabel(view, t) }))}
        selectedAccountId={editingId} onReorder={onReorder}
        labels={{ list: t('views.section'), instructions: t('views.reorderInstructions'),
          reorder: name => t('views.reorder', { name }) }}>
      {view => <button type="button" data-testid={`views-row-${view.id}`}
            className={`views-row-button account-settings-account-button${editingId === view.id ? ' is-editing' : ''}`}
            aria-expanded={editingId === view.id}
            onClick={() => onSelect(view.id)}>
            <ViewIcon icon={view.icon} size={14} />
            <span className="views-row-name">{viewLabel(view, t)}</span>
          </button>}
      </ReorderListView>
      {views.length === 0 && <p className="views-empty" data-testid="views-empty">{t('views.none')}</p>}
    </div>
    {note}

    </SettingsSection>

    {children}
  </SettingsPageLayout>;
}
