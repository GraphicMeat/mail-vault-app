import React, { useId, useState } from 'react';
import { EmailRow, CompactEmailRow, listRowHeight } from '../EmailRow';
import { SelectionActionBarView } from '../SelectionActionBar';
import { QuickActionWheelInPlace } from '../QuickActions';
import { EmailActionBar } from '../email/EmailActionBar';
import { ChoiceCards } from '../ui/ChoiceCards';
import { normalizeListPreviewLines, useSettingsStore } from '../../stores/settingsStore';
import { QUICK_ACTION_MODES } from '../../utils/quickActions';
import { QUICK_ACTION_PRESETS, activeQuickActionPreset } from '../../utils/quickActionPresets';
import { getSenderName } from '../../utils/emailParser';
import { displayText } from '../../utils/bidiText';
import { useT } from '../../i18n/index.js';
import { Private } from '../privacy/Private';

// Quick actions are the one Appearance setting whose examples are the real
// thing: the list row, the selection bar and the reader toolbar, over the
// person's own latest mail (hooks/useQuickActionSamples.js). Every action and
// handler here is a no-op, and a click that is not on a quick action never
// reaches the component under it. A wheel or menu opens from its trigger over
// the page, as in the list; only an option card draws a wheel open in place.

const NOOP = () => {};
// The keys EmailList hands its rows.
const NOOP_ROW_ACTIONS = Object.freeze({
  saveEmailLocally: NOOP, removeLocalEmail: NOOP, removeLocalEmails: NOOP,
  deleteEmailFromServer: NOOP, saveEmailsLocally: NOOP, toggleFlagged: NOOP,
});
// A reader action with no handler is hidden, so each gets one.
const NOOP_READER = Object.freeze(Object.fromEntries([
  'onReply', 'onReplyAll', 'onForward', 'onArchive', 'onDelete', 'onDeleteEverywhere', 'onMove',
  'onToggleRead', 'onToggleFlag', 'onSpam', 'onApplyLocalLabel', 'onReplyTemplate', 'onOpenInWindow',
  'onViewSource', 'onExport', 'onToggleEmailTheme',
].map(name => [name, NOOP])));

const layoutLabelKey = mode => `quickActions.layout.${mode === 'favorite-menu' ? 'favoriteMenu' : mode}`;

// One surface drawn by its own component, `config` in place of the saved set.
// `list` draws it where it sits: a row between two neighbours, the bar under
// three ticked rows, the toolbar over the message's subject.
function SurfaceSample({ surface, config, rows, onAction = NOOP, list = false }) {
  const t = useT();
  const compact = useSettingsStore(state => state.emailListStyle) === 'compact';
  const previewLines = useSettingsStore(state => normalizeListPreviewLines(state.listPreviewLines));
  const density = useSettingsStore(state => state.listDensity);
  const Row = compact ? CompactEmailRow : EmailRow;
  const height = listRowHeight(compact, previewLines, density);
  const row = (email, props) => <div key={email.uid} className="quick-actions-sample-row" style={{ height }}>
    <Row rowId={`sample:${email.uid}`} email={email} style={{ height }} isSelected={false} isChecked={false}
      onSelect={NOOP} onToggleSelection={NOOP} actions={NOOP_ROW_ACTIONS} onRequestDelete={NOOP}
      onOpenMenu={NOOP} onCloseMenu={NOOP} onStartSaving={NOOP} onStopSaving={NOOP}
      preview configOverride={config} {...props} />
  </div>;
  if (surface === 'selection') {
    const selected = rows.slice(0, 3);
    return <>
      {list && selected.map(email => row(email, { isChecked: true }))}
      <div className="quick-actions-sample-bar"><SelectionActionBarView rows={selected} config={config} preview /></div>
    </>;
  }
  if (surface === 'reader') {
    const email = rows[0];
    return <>
      <EmailActionBar email={email} variant="single" configOverride={config} preview onActionPreview={onAction}
        {...NOOP_READER} isArchived={!!email.isArchived} isRead={!!email.flags?.includes('\\Seen')}
        isLocalOnly={false} isSentEmail={false} singleRecipient={false} />
      {list && <div className="quick-actions-sample-reader">
        <strong dir="auto"><Private kind="text">{displayText(email.subject, t('common.noSubject'))}</Private></strong>
        <span dir="auto"><Private kind="name">{getSenderName(email)}</Private></span>
      </div>}
    </>;
  }
  return list
    ? rows.slice(0, 3).map((email, index) => row(email, { pinActions: index === 1 }))
    : row(rows[0], { pinActions: true });
}

// A click on a quick action (all no-ops here) goes through, and so does one in
// a menu such a click opened: that sits in a portal, outside this element.
// Anything else, the row itself, its star, checkbox or tag chip, would act on
// the real message.
function shield(event) {
  if (!event.currentTarget.contains(event.target)) return;
  if (event.target.closest('.quick-actions, .quick-actions-radial')) return;
  event.preventDefault();
  event.stopPropagation();
}

/** The live example under the surface tabs: where it shows, drawn on the person's mail. */
export function QuickActionSample({ surface, config, rows }) {
  const t = useT();
  const id = useId();
  const [status, setStatus] = useState('');
  return <section className="quick-actions-sample" aria-labelledby={id}>
    <h5 id={id}>{t('quickActions.preview')}</h5>
    <p className="text-xs text-mail-text-muted">{t(`quickActions.where.${surface}`)} {t('quickActions.previewDescription')}</p>
    <div className="quick-actions-sample-frame" data-quick-actions-preview data-sample-surface={surface}
      data-sample-account={rows[0]?._accountId}
      onClickCapture={event => {
        if (event.target.closest?.('[data-quick-action]')) setStatus(t('quickActions.previewResult'));
        shield(event);
      }}>
      <SurfaceSample surface={surface} config={config} rows={rows} list onAction={() => setStatus(t('quickActions.previewResult'))} />
    </div>
    <p role="status" className="text-xs text-mail-text-muted">{status}</p>
  </section>;
}

/** A card's picture of one option: the same surface, small and inert, its wheel drawn open. */
export function CardSample({ surface, config, rows }) {
  return <div className="quick-actions-card-sample" data-quick-actions-preview aria-hidden="true" inert="">
    <QuickActionWheelInPlace.Provider value>
      <div className="quick-actions-card-sample-content"><SurfaceSample surface={surface} config={config} rows={rows} /></div>
    </QuickActionWheelInPlace.Provider>
  </div>;
}

/**
 * The action sets of other mail apps, each drawn as the row it gives. One
 * click sets all three surfaces of `scope` (null: All views); the set the
 * scope shows exactly is marked, none when it has been changed since.
 */
export function QuickActionPresets({ scope, rows }) {
  const t = useT();
  const id = useId();
  const quickActions = useSettingsStore(state => state.quickActions);
  const apply = useSettingsStore(state => state.applyQuickActionPreset);
  const active = activeQuickActionPreset(quickActions, scope);
  return <section className="quick-actions-presets" aria-labelledby={id}>
    <div className="quick-actions-presets-heading">
      <h5 id={id}>{t('quickActions.presets')}</h5>
      {!active && <span data-testid="quick-actions-preset-custom">{t('quickActions.preset.custom')}</span>}
    </div>
    <p className="text-xs text-mail-text-muted">{t('quickActions.presetHint')}</p>
    <ChoiceCards pressed label={t('quickActions.presets')} value={active} onChange={presetId => apply(presetId, scope)}
      options={QUICK_ACTION_PRESETS.map(preset => ({
        value: preset.id,
        label: t(preset.labelKey),
        preview: <CardSample surface="row" config={preset.surfaces.row} rows={rows} />,
      }))} />
  </section>;
}

/** Layout as cards, each the surface in that layout. */
export function QuickActionLayoutCards({ surface, config, rows, onChange }) {
  const t = useT();
  return <ChoiceCards label={t('quickActions.layout')} value={config.mode} onChange={onChange}
    options={QUICK_ACTION_MODES.map(mode => ({
      value: mode,
      label: t(layoutLabelKey(mode)),
      preview: <CardSample surface={surface} config={{ ...config, mode }} rows={rows} />,
    }))} />;
}
