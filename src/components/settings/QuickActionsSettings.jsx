import React, { useEffect, useMemo, useRef, useState } from "react";
import { GripVertical, Plus, X } from "lucide-react";
import { QuickActionModeTiles, QuickActionPaletteDots, QuickActionPresets, QuickActionSample } from "./QuickActionSamples";
import { SettingsTabs } from "../ui/SettingsTabs";
import { SegmentedChoice } from "../ui/SegmentedChoice";
import { ToggleSwitch } from "../ui/ToggleSwitch";
import { TomSelectField } from "../ui/TomSelectField";
import { useMailStore } from "../../stores/mailStore";
import { useTagStore } from "../../stores/tagStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useQuickActionConfiguration } from "../../hooks/useQuickActionConfiguration";
import { useQuickActionSamples } from "../../hooks/useQuickActionSamples";
import {
  DEFAULT_QUICK_ACTIONS,
  insertQuickActionEntry,
  normalizeQuickActions,
  isQuickActionStyleLinked,
  QUICK_ACTION_SURFACES,
  QUICK_ACTION_SURFACE_ACTIONS as SURFACE_ACTIONS,
  quickActionScopeKey,
  RADIAL_CATEGORIES,
  resolveQuickActions,
} from "../../utils/quickActions";
import { quickActionColorFor } from "../../utils/quickActionColors";
import { QUICK_ACTION_ICONS as ICONS } from "../../utils/quickActionIcons";
import { useT } from "../../i18n/index.js";
import { DesktopViewEnv } from "./DesktopViewEnv";
import { QuickActionsView } from "./views/QuickActionsView";

const LABELS = {
  archive: "common.archive",
  unarchive: "rowMenu.unarchive",
  delete: "common.delete",
  deleteServer: "rowMenu.deleteServer",
  deleteEverywhere: "rowMenu.deleteEverywhere",
  toggleRead: "quickActions.action.toggleRead",
  markRead: "rowMenu.markRead",
  markUnread: "rowMenu.markUnread",
  star: "rowMenu.star",
  unstar: "rowMenu.unstar",
  tag: "quickActions.action.tag",
  move: "quickActions.action.move",
  spam: "quickActions.action.spam",
  reply: "emailActionBar.reply",
  replyAll: "emailActionBar.replyAll",
  forward: "emailActionBar.forward",
  replyTemplate: "quickActions.action.replyTemplate",
  export: "common.export",
  newMessage: "quickActions.action.newMessage",
  open: "chat.bubble.openNewWindow",
  source: "emailActionBar.source",
  theme: "emailActionBar.dark",
  snooze: "snooze.action",
  unsubscribe: "unsubscribe.action",
  goToMailbox: "rowMenu.goToMailbox",
};
const EMPTY_ARRAY = Object.freeze([]);
const newEntry = (action, params = {}) => ({
  id: action === "tag"
    ? `tag:${params.tagId}`
    : action === "replyTemplate"
    ? `replyTemplate:${params.templateId}`
    : action === "move" && params.mailbox
    ? `move:${params.accountId || ""}:${params.mailbox}`
    : action,
  action,
  ...(Object.keys(params).length ? { params } : {}),
});

/**
 * The actions of one surface as chips in one strip, in the order they show.
 * A chip's grip moves it with the arrow keys; a chip dragged onto another takes
 * its place; × removes it. With custom colors each chip carries its own color.
 */
function ActionStrip({ entries, palette, onReorder, onRemove, onColor, children }) {
  const t = useT();
  const dragged = useRef(null);
  const ids = entries.map((entry) => entry.id);
  const move = (from, to) => {
    if (to < 0 || to >= ids.length || from === to) return;
    const next = [...ids];
    next.splice(to, 0, next.splice(from, 1)[0]);
    onReorder(next);
  };
  return (
    <div className="quick-actions-strip-row">
      <ul className="quick-actions-strip" aria-label={t("quickActions.actionList")}>
        {entries.map((entry, index) => (
          <li key={entry.id} data-entry={entry.id} draggable className="quick-actions-chip" data-colored={!!entry.editorColor}
            style={entry.editorColor ? { "--quick-action-editor-color": entry.editorColor } : undefined}
            onDragStart={(event) => { dragged.current = entry.id; event.dataTransfer?.setData?.("text/plain", entry.id); }}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              const id = dragged.current || event.dataTransfer?.getData?.("text/plain");
              dragged.current = null;
              move(ids.indexOf(id), index);
            }}>
            <button type="button" className="quick-actions-chip-grip" aria-label={t("quickActions.reorder", { name: entry.label })}
              title={t("quickActions.reorderChipInstructions")}
              onKeyDown={(event) => {
                const step = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[event.key];
                if (!step) return;
                event.preventDefault();
                move(index, index + step);
              }}>
              <GripVertical size={12} aria-hidden="true" />
            </button>
            <span className="quick-actions-chip-name">{entry.label}</span>
            {palette === "custom" && (
              <input type="color" className="quick-actions-chip-color" aria-label={`${t("quickActions.color")} ${entry.label}`}
                value={entry.color || "#a0a0b6"} onChange={(event) => onColor(index, event.target.value)} />
            )}
            <button type="button" className="quick-actions-remove" aria-label={`${t("quickActions.removeAction")} ${entry.label}`}
              title={t("quickActions.removeAction")} onClick={() => onRemove(index)}>
              <X size={13} aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
      {children}
    </div>
  );
}

/**
 * Every action this surface can show, in one searchable list grouped the way
 * new actions are placed. An action that needs a folder, a label or a template
 * asks for it here, in place of the list, before it is added.
 */
function AddActionPicker({ surface, present, labels, templates, folders, getActionLabel, onAdd, onCreateLabel }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [asking, setAsking] = useState(null);
  const [newLabel, setNewLabel] = useState("");
  const root = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const away = (event) => { if (!root.current?.contains(event.target)) close(); };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const close = () => { setOpen(false); setQuery(""); setAsking(null); setNewLabel(""); };
  const add = (action, params) => { onAdd(action, params); close(); };
  const pick = (action) => (["move", "tag", "replyTemplate"].includes(action) ? setAsking(action) : add(action));
  const needle = query.trim().toLowerCase();
  const groups = Object.entries(RADIAL_CATEGORIES).map(([category, actions]) => [category,
    actions.filter((action) => SURFACE_ACTIONS[surface].includes(action))
      .filter((action) => !needle || getActionLabel(action).toLowerCase().includes(needle))])
    .filter(([, actions]) => actions.length);
  const choice = (key, label, onClick, disabled = false) =>
    <button key={key} type="button" className="quick-actions-picker-item" disabled={disabled} onClick={onClick}>{label}</button>;
  return (
    <div className="quick-actions-add" ref={root}>
      <button type="button" className="quick-actions-add-button" aria-haspopup="dialog" aria-expanded={open}
        aria-label={t("quickActions.addAction")} title={t("quickActions.addAction")} onClick={() => (open ? close() : setOpen(true))}>
        <Plus size={14} aria-hidden="true" />
      </button>
      {open && (
        <div className="quick-actions-picker" role="dialog" aria-label={t("quickActions.addAction")}
          onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); close(); } }}>
          {!asking && <>
            <input type="search" autoFocus value={query} onChange={(event) => setQuery(event.target.value)}
              placeholder={t("quickActions.findAction")} aria-label={t("quickActions.findAction")} />
            <div className="quick-actions-picker-list">
              {groups.map(([category, actions]) => (
                <div key={category} role="group" aria-label={t(`quickActions.category.${category}`)}>
                  <p className="quick-actions-picker-group">{t(`quickActions.category.${category}`)}</p>
                  {actions.map((action) => {
                    const Icon = ICONS[action];
                    const added = !["move", "tag", "replyTemplate"].includes(action) && present.has(action);
                    return <button key={action} type="button" data-action={action} className="quick-actions-picker-item"
                      disabled={added} onClick={() => pick(action)}>
                      {Icon && <Icon size={13} aria-hidden="true" />}
                      {getActionLabel(action)}
                    </button>;
                  })}
                </div>
              ))}
              {!groups.length && <p className="quick-actions-picker-empty">{t("quickActions.noActionMatch")}</p>}
            </div>
          </>}
          {asking === "move" && <div className="quick-actions-picker-list" role="group" aria-label={t("quickActions.param.folder")}>
            <p className="quick-actions-picker-group">{t("quickActions.param.folder")}</p>
            {choice("each", t("quickActions.param.folderPicker"), () => add("move"), present.has("move"))}
            {folders.map((item) => choice(item.path, item.name || item.path, () => add("move", { mailbox: item.path }), present.has(`move:${item.path}`)))}
          </div>}
          {asking === "tag" && <div className="quick-actions-picker-list" role="group" aria-label={t("quickActions.param.label")}>
            <p className="quick-actions-picker-group">{t("quickActions.param.label")}</p>
            {labels.map((label) => choice(label.id, label.name, () => add("tag", { tagId: label.id }), present.has(`tag:${label.id}`)))}
            <form className="quick-actions-picker-new" onSubmit={async (event) => {
              event.preventDefault();
              const name = newLabel.trim();
              if (!name) return;
              const label = await onCreateLabel(name);
              if (label) add("tag", { tagId: label.id });
            }}>
              <input value={newLabel} maxLength={80} onChange={(event) => setNewLabel(event.target.value)}
                placeholder={t("quickActions.param.labelName")} aria-label={t("quickActions.param.labelName")} />
              <button type="submit" disabled={!newLabel.trim()}>{t("quickActions.param.createLabel")}</button>
            </form>
          </div>}
          {asking === "replyTemplate" && <div className="quick-actions-picker-list" role="group" aria-label={t("quickActions.param.template")}>
            <p className="quick-actions-picker-group">{t("quickActions.param.template")}</p>
            {templates.map((item) => choice(item.id, item.name, () => add("replyTemplate", { templateId: item.id }), present.has(`replyTemplate:${item.id}`)))}
            {!templates.length && <p className="quick-actions-picker-empty">{t("quickActions.param.unavailable")}</p>}
          </div>}
        </div>
      )}
    </div>
  );
}

export function QuickActionsSettings() {
  const t = useT();
  const quickActions = useSettingsStore((state) => state.quickActions);
  const setSurface = useSettingsStore((state) => state.setQuickActionSurface);
  const setStyle = useSettingsStore((state) => state.setQuickActionStyle);
  const setStyleLink = useSettingsStore((state) => state.setQuickActionStyleLink);
  const resetScope = useSettingsStore((state) => state.resetQuickActionScope);
  const labels = useTagStore((state) => state.tags) || EMPTY_ARRAY;
  const createTag = useTagStore((state) => state.createTag);
  const templates = useSettingsStore((state) => state.emailTemplates) ||
    EMPTY_ARRAY;
  const mailboxes = useMailStore((state) => state.mailboxes) || EMPTY_ARRAY;
  const activeAccountId = useMailStore((state) => state.activeAccountId);
  const activeMailbox = useMailStore((state) => state.activeMailbox);
  const accounts = useMailStore((state) => state.accounts) || EMPTY_ARRAY;
  const [surface, setSurfaceId] = useState("row");
  // Only what the person picked. Until then each surface opens on the scope
  // that actually governs the current view: a view with its own override shown
  // as "All views" made every edit there look ignored.
  const [scopeChoices, setScopeChoices] = useState({});
  const samples = useQuickActionSamples();
  const { scope } = useQuickActionConfiguration(surface);
  const scopeKey = quickActionScopeKey(scope);
  const normalized = useMemo(() => normalizeQuickActions(quickActions), [
    quickActions,
  ]);
  // The view sets some of this surface itself, so All views does not fully
  // reach it: said whichever scope is being edited.
  const viewDiffers = !!(scopeKey && normalized.overrides[scopeKey]?.[surface]);
  const scopeChoice = scopeChoices[surface] || (viewDiffers ? "current" : "global");
  const pickScope = (choice) => setScopeChoices((choices) => ({ ...choices, [surface]: choice }));
  const isGlobal = scopeChoice === "global";
  const activeAccount = accounts.find((account) =>
    account.id === scope.accountId || account.id === activeAccountId
  );
  const scopeName = scope.view === "explorer"
    ? t("quickActions.scope.kind.explorer")
    : t(`quickActions.scope.kind.${scope.kind}`);
  const scopeDescription = [scopeName, activeAccount?.email, scope.mailbox]
    .filter(Boolean).join(" · ");
  const resolved = isGlobal
    ? { config: normalized.defaults[surface], inherited: false }
    : resolveQuickActions(normalized, surface, scope);
  const config = resolved.config;
  const linkedStyle = isQuickActionStyleLinked(normalized, isGlobal ? null : scope);

  const persist = (next) => setSurface(surface, isGlobal ? null : scope, next);
  const persistStyle = (updates) => setStyle(surface, isGlobal ? null : scope, updates);
  const resetSurface = () => {
    const defaults = DEFAULT_QUICK_ACTIONS.defaults[surface];
    persist(defaults);
    if (linkedStyle) persistStyle({
      mode: defaults.mode,
      palette: defaults.palette,
      radialPagination: defaults.radialPagination,
      radialLayout: defaults.radialLayout,
    });
  };
  const inheritAllViews = () => {
    // Pinned: once the override is gone the fallback would jump to All views.
    if (!isGlobal) pickScope("current");
    resetScope(scope, surface);
  };
  const setMode = (mode) => persistStyle({ mode });
  const updateEntry = (index, updates) =>
    persist({
      ...config,
      entries: config.entries.map((entry, i) =>
        i === index ? { ...entry, ...updates } : entry
      ),
    });
  const removeEntry = (index) =>
    persist({
      ...config,
      entries: config.entries.filter((_, i) => i !== index),
    });
  const reorderEntries = (ids) => {
    const byId = new Map(config.entries.map((entry) => [entry.id, entry]));
    persist({ ...config, entries: ids.map((id) => byId.get(id)).filter(Boolean) });
  };
  const addAction = (action, params = {}) => {
    const item = newEntry(action, action === "move" && params.mailbox
      ? { mailbox: params.mailbox, accountId: activeAccountId || "" }
      : params);
    if (config.entries.some((entry) => entry.id === item.id)) return;
    persist({ ...config, entries: insertQuickActionEntry(config.entries, item) });
  };

  const getLabel = (entry) => {
    if (entry.action === "tag") {
      return labels.find((item) => item.id === entry.params?.tagId)?.name ||
        t("quickActions.action.tag");
    }
    if (entry.action === "move" && entry.params?.mailbox) {
      return `${t("quickActions.action.move")}: ${entry.params.mailbox}`;
    }
    if (entry.action === "replyTemplate") {
      return templates.find((item) => item.id === entry.params?.templateId)
        ?.name || t("quickActions.action.replyTemplate");
    }
    return t(LABELS[entry.action] || "quickActions.title");
  };
  // Tom Select rebuilds its list whenever `options` changes identity, so the
  // list only changes when a label or an entry does.
  const favoriteKey = JSON.stringify([
    { value: "", label: t("quickActions.param.autoFavorite") },
    ...config.entries.map((item) => ({ value: item.id, label: getLabel(item) })),
  ]);
  const favoriteOptions = useMemo(() => JSON.parse(favoriteKey), [favoriteKey]);
  // `move:<mailbox>` marks a folder already saved, whichever account it was saved from.
  const present = new Set(config.entries.flatMap((entry) => [entry.id,
    ...(entry.action === "move" && entry.params?.mailbox ? [`move:${entry.params.mailbox}`] : [])]));
  const folders = mailboxes.filter((item) => !item.noselect && item.path && item.path !== activeMailbox);
  const selectionChoices = surface === "selection" && ["inline", "favorite-menu"].includes(config.mode);

  return (
    <DesktopViewEnv>
    <QuickActionsView>
      <div className="quick-actions-settings-simple">
      <QuickActionPresets scope={isGlobal ? null : scope} />
      <SettingsTabs
        tabs={QUICK_ACTION_SURFACES.map((name) => ({
          id: name,
          label: t(`quickActions.surface.${name}`),
        }))}
        value={surface}
        onChange={setSurfaceId}
        label={t("quickActions.surface")}
      >
        <QuickActionSample key={surface} surface={surface} config={config} rows={samples} />

        <ActionStrip
          entries={config.entries.map((entry) => ({ ...entry, label: getLabel(entry), editorColor: quickActionColorFor(entry, config.palette) }))}
          palette={config.palette}
          onReorder={reorderEntries}
          onRemove={removeEntry}
          onColor={(index, color) => updateEntry(index, { color })}
        >
          <AddActionPicker surface={surface} present={present} labels={labels} templates={templates} folders={folders}
            getActionLabel={(action) => t(LABELS[action] || "quickActions.title")}
            onAdd={addAction} onCreateLabel={(name) => createTag(name).catch(() => null)} />
        </ActionStrip>

        <div className="quick-actions-look">
          <div className="quick-actions-choice-field">
            <span>{t("quickActions.layout")}</span>
            <QuickActionModeTiles value={config.mode} onChange={setMode} />
          </div>
          <div className="quick-actions-choice-field">
            <span>{t("quickActions.palette")}</span>
            <QuickActionPaletteDots value={config.palette} onChange={(palette) => persistStyle({ palette })} />
          </div>
        </div>

        {/* One line, only for the layout chosen: what that layout asks. */}
        {(config.mode === "radial" || config.mode === "favorite-menu" || selectionChoices) && (
          <div className="quick-actions-context" data-mode={config.mode}>
            {config.mode === "radial" && <>
              <SegmentedChoice label={t("quickActions.radialLayout")}
                value={config.radialLayout === "categories" ? "categories" : "flat"}
                onChange={(value) => persistStyle({ radialLayout: value })}
                options={[
                  { value: "flat", label: t("quickActions.radialLayout.flat") },
                  { value: "categories", label: t("quickActions.radialLayout.categories") },
                ]} />
              {config.radialLayout !== "categories" && (
                <SegmentedChoice label={t("quickActions.radialPagination")}
                  value={config.radialPagination ? "pages" : "all"}
                  onChange={(value) => persistStyle({ radialPagination: value === "pages" })}
                  options={[
                    { value: "all", label: t("quickActions.radialPagination.all") },
                    { value: "pages", label: t("quickActions.radialPagination.pages") },
                  ]} />
              )}
            </>}
            {config.mode === "favorite-menu" && (
              <label className="quick-actions-favorite-row">
                {t("quickActions.favorite")}
                <TomSelectField
                  label={t("quickActions.favorite")}
                  value={config.favoriteId || ""}
                  placeholder={t("quickActions.param.autoFavorite")}
                  options={favoriteOptions}
                  onChange={(favoriteId) =>
                    persist({ ...config, favoriteId: favoriteId || null })}
                />
              </label>
            )}
            {selectionChoices && <>
              <SegmentedChoice label={t("quickActions.selectionDisplay")}
                value={config.selectionDisplay || "icon-label"}
                onChange={(selectionDisplay) => persist({ ...config, selectionDisplay })}
                options={[
                  { value: "icon-label", label: t("quickActions.selectionDisplay.iconLabel") },
                  { value: "icon-only", label: t("quickActions.selectionDisplay.iconOnly") },
                ]} />
              {config.mode === "inline" && config.selectionDisplay !== "icon-only" && (
                <label className="quick-actions-selection-limit">
                  {t("quickActions.selectionLimit")}
                  <input
                    aria-label={t("quickActions.selectionLimit")}
                    type="number"
                    min="1"
                    max="6"
                    value={config.selectionActionLimit || 3}
                    onChange={(event) =>
                      persist({
                        ...config,
                        selectionActionLimit: Number(event.target.value),
                      })}
                  />
                </label>
              )}
            </>}
          </div>
        )}

        <div className="quick-actions-footer">
          <label className="quick-actions-link-switch">
            <ToggleSwitch label={t("quickActions.sameLook")} active={linkedStyle}
              onClick={() => setStyleLink(isGlobal ? null : scope, !linkedStyle, surface)} />
            <span>{t("quickActions.sameLook")}</span>
          </label>
          <span className="quick-actions-scope">
            <SegmentedChoice
              label={t("quickActions.scope")}
              value={scopeChoice}
              onChange={pickScope}
              options={[
                { value: "global", label: t("quickActions.scope.global") },
                { value: "current", label: t("quickActions.scope.current"), disabled: !scopeKey },
              ]}
            />
            {scopeKey && <span className="quick-actions-choice-hint">{scopeDescription}</span>}
          </span>
          <span className="quick-actions-scope-status text-xs text-mail-text-muted">
            {/* No "customize" step: an edit on Current view stores what it changes. */}
            {viewDiffers && <>
              <span role="status">{t("quickActions.scope.differs")}</span>
              <button type="button" onClick={inheritAllViews}>{t("quickActions.scope.useGlobal")}</button>
            </>}
            {!isGlobal && !viewDiffers && <span role="status">{t("quickActions.scope.inherited")}</span>}
            {isGlobal && <button type="button" onClick={resetSurface}>{t("common.resetToDefault")}</button>}
          </span>
        </div>
      </SettingsTabs>
      </div>
    </QuickActionsView>
    </DesktopViewEnv>
  );
}
