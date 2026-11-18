// Settings > Appearance > Quick actions: the parts both apps render, as views. Desktop's container
// (QuickActionsSettings.jsx) adds what only its surfaces have: the scope, the surface tabs, the
// live samples drawn with the real list row, selection bar and wheel, layouts, palettes and labels.
// The phone has one surface, the bar under an open message, and draws no sample.
//
// - QuickActionsView: the section's heading and description around its parts.
// - QuickActionPresetsView: other mail apps' action sets as cards (`presets`: `[{ id, labelKey }]`,
//   `active`: the set shown exactly, or null when changed since; `preview(id)`: its picture).
// - QuickActionEntryListView: the actions in order (`entries`: `[{ id, label, color }]`), each
//   removable, reordered by its handle; `onColor(index, color)` while `palette` is custom.
// - QuickActionAddView: pick an action (`actions`: `[{ value, labelKey }]`) and add it; `children`
//   holds the picked action's parameters; `blocked` while it cannot be added.
import React, { useId } from 'react';
import { Trash2 } from 'lucide-react';
import { ChoiceCards } from '../../ui/ChoiceCards';
import { ReorderListView } from './ReorderListView';
import { useT } from './viewContext';
import '../../../styles/quick-actions.css';
import '../../../styles/settings-usability.css';
import '../../../styles/account-settings-navigation.css';

export function QuickActionsView({ description = null, children }) {
  const t = useT();
  return (
    <div className="settings-preference-group quick-actions-settings">
      <h4>{t("quickActions.title")}</h4>
      <p className="text-sm text-mail-text-muted">
        {description ?? t("quickActions.description")}
      </p>
      {children}
    </div>
  );
}

export function QuickActionPresetsView({ presets, active, onApply, preview = () => null }) {
  const t = useT();
  const id = useId();
  return <section className="quick-actions-presets" aria-labelledby={id}>
    <div className="quick-actions-presets-heading">
      <h5 id={id}>{t('quickActions.presets')}</h5>
      {!active && <span data-testid="quick-actions-preset-custom">{t('quickActions.preset.custom')}</span>}
    </div>
    <p className="text-xs text-mail-text-muted">{t('quickActions.presetHint')}</p>
    <ChoiceCards pressed label={t('quickActions.presets')} value={active} onChange={onApply}
      options={presets.map(preset => ({
        value: preset.id,
        label: t(preset.labelKey),
        preview: preview(preset.id),
      }))} />
  </section>;
}

export function QuickActionEntryListView({ entries, onReorder, onRemove, palette = null, onColor = () => {} }) {
  const t = useT();
  return (
    <div className="quick-actions-entry-list">
      <ReorderListView
        accounts={entries.map((entry) => ({ ...entry, email: entry.label }))}
        onReorder={onReorder}
        labels={{
          list: t("quickActions.actionList"),
          instructions: t("quickActions.reorderInstructions"),
          reorder: (name) => t("quickActions.reorder", { name }),
        }}
      >
        {(entry) => {
          const index = entries.findIndex((item) => item.id === entry.id);
          const entryColor = entry.editorColor;
          return <div className="quick-actions-entry" data-colored={!!entryColor}
            style={entryColor ? { "--quick-action-editor-color": entryColor } : undefined}>
            <span className="quick-actions-entry-name">
              {entry.email}
            </span>
            <button
              type="button"
              className="quick-actions-remove"
              aria-label={`${t("quickActions.removeAction")} ${entry.email}`}
              title={t("quickActions.removeAction")}
              onClick={() => onRemove(index)}
            >
              <Trash2 size={15} aria-hidden="true" />
            </button>
            {palette === "custom" && (
              <label className="quick-actions-color-control">
                {t("quickActions.color")}
                <input
                  type="color"
                  aria-label={`${t("quickActions.color")} ${entry.email}`}
                  value={entry.color || "#a0a0b6"}
                  onChange={(event) => onColor(index, event.target.value)}
                />
                {!entry.color && <span>{t("quickActions.colorDefault")}</span>}
                {entry.color && <button
                  type="button"
                  aria-label={`${t("quickActions.resetColor")} ${entry.email}`}
                  onClick={() => onColor(index, undefined)}
                >{t("quickActions.resetColor")}</button>}
              </label>
            )}
          </div>;
        }}
      </ReorderListView>
    </div>
  );
}

export function QuickActionAddView({ actions, addType, onAddType, onAdd, blocked, editorColor = null, children = null }) {
  const t = useT();
  return (
    <div className="quick-actions-add-row" data-colored={!!editorColor}
      style={editorColor ? { "--quick-action-editor-color": editorColor } : undefined}>
      <label>
        {t("quickActions.action")}
        <select
          aria-label={t("quickActions.action")}
          value={addType}
          onChange={(event) => onAddType(event.target.value)}
        >
          {actions.map(({ value: action, labelKey }) => (
            <option key={action} value={action}>
              {t(labelKey)}
            </option>
          ))}
        </select>
      </label>
      {children}
      <button
        type="button"
        aria-label={t("quickActions.addAction")}
        disabled={!!blocked}
        onClick={onAdd}
      >
        {t("quickActions.addAction")}
      </button>
    </div>
  );
}
