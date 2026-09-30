import React, { useEffect, useMemo, useState } from "react";
import { Trash2 } from "lucide-react";
import { AccountReorderList } from "./AccountReorderList";
import { CardSample, QuickActionLayoutCards, QuickActionPresets, QuickActionSample } from "./QuickActionSamples";
import { SettingsTabs } from "../ui/SettingsTabs";
import { SegmentedChoice } from "../ui/SegmentedChoice";
import { ChoiceCards } from "../ui/ChoiceCards";
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
  QUICK_ACTION_PALETTES,
  QUICK_ACTION_SURFACES,
  QUICK_ACTION_SURFACE_ACTIONS as SURFACE_ACTIONS,
  quickActionScopeKey,
  RADIAL_CATEGORIES,
  resolveQuickActions,
} from "../../utils/quickActions";
import { quickActionColorFor } from "../../utils/quickActionColors";
import { QUICK_ACTION_ICONS as ICONS } from "../../utils/quickActionIcons";
import { useT } from "../../i18n/index.js";
import "../../styles/settings-usability.css";
import "../../styles/account-settings-navigation.css";

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
  open: "common.open",
  source: "emailActionBar.source",
  theme: "emailActionBar.dark",
  snooze: "snooze.action",
  unsubscribe: "unsubscribe.action",
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

export function QuickActionsSettings() {
  const t = useT();
  const quickActions = useSettingsStore((state) => state.quickActions);
  const setSurface = useSettingsStore((state) => state.setQuickActionSurface);
  const setStyle = useSettingsStore((state) => state.setQuickActionStyle);
  const setStyleLink = useSettingsStore((state) => state.setQuickActionStyleLink);
  const resetScope = useSettingsStore((state) => state.resetQuickActionScope);
  const labels = useTagStore((state) => state.tags) || EMPTY_ARRAY;
  const createTag = useTagStore((state) => state.createTag);
  const deleteTag = useTagStore((state) => state.deleteTag);
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
  const [newLabelName, setNewLabelName] = useState("");
  const [addType, setAddType] = useState("archive");
  const [tagId, setTagId] = useState("");
  const [folder, setFolder] = useState("");
  const [templateId, setTemplateId] = useState("");
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

  useEffect(() => {
    if (!SURFACE_ACTIONS[surface].includes(addType)) {
      setAddType(SURFACE_ACTIONS[surface][0]);
    }
  }, [surface, addType]);

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

  const addAction = async () => {
    let params = {};
    if (addType === "tag") {
      let label = labels.find((item) => item.id === tagId);
      if (!label && newLabelName.trim()) label = await createTag(newLabelName.trim()).catch(() => null);
      if (!label) return;
      params = { tagId: label.id };
      setTagId(label.id);
      setNewLabelName("");
    } else if (addType === "move" && folder) {
      params = { mailbox: folder, accountId: activeAccountId || "" };
    } else if (addType === "replyTemplate") {
      if (!templates.some((item) => item.id === templateId)) return;
      params = { templateId };
    }
    const item = newEntry(addType, params);
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
  // Each option's card draws this surface as that option would.
  const cards = (options, override) => options.map(({ value, label }) => ({
    value,
    label,
    preview: <CardSample surface={surface} config={{ ...config, ...override(value) }} rows={samples} />,
  }));
  const addNeedsTag = addType === "tag";
  const addNeedsFolder = addType === "move";
  const addNeedsTemplate = addType === "replyTemplate";
  const addBlocked = addNeedsTag && !tagId && !newLabelName.trim() ||
    addNeedsTemplate && !templates.some((item) => item.id === templateId);

  return (
    <div className="settings-preference-group quick-actions-settings">
      <h4>{t("quickActions.title")}</h4>
      <p className="text-sm text-mail-text-muted">
        {t("quickActions.description")}
      </p>
      <QuickActionPresets scope={isGlobal ? null : scope} rows={samples} />
      <div className="quick-actions-choice-field quick-actions-scope">
        <span>{t("quickActions.scope")}</span>
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
      </div>
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

        <div className="quick-actions-choice-field">
          <span>{t("quickActions.styleAcrossSurfaces")}</span>
          <SegmentedChoice
            label={t("quickActions.styleAcrossSurfaces")}
            value={linkedStyle ? "linked" : "separate"}
            onChange={(choice) => setStyleLink(isGlobal ? null : scope, choice === "linked", surface)}
            options={[
              { value: "separate", label: t("quickActions.styleSeparate") },
              { value: "linked", label: t("quickActions.styleLinked") },
            ]}
          />
        </div>

        <div className="quick-actions-option-cards">
          <div className="quick-actions-choice-field">
            <span>{t("quickActions.layout")}</span>
            <QuickActionLayoutCards surface={surface} config={config} rows={samples} onChange={setMode} />
          </div>
          <div className="quick-actions-choice-field">
            <span>{t("quickActions.palette")}</span>
            {/* Inline in every card: a menu's trigger shows no colors. */}
            <ChoiceCards
              label={t("quickActions.palette")}
              value={config.palette}
              onChange={(palette) => persistStyle({ palette })}
              options={cards(QUICK_ACTION_PALETTES.map((palette) => ({ value: palette, label: t(`quickActions.palette.${palette}`) })),
                (palette) => ({ palette, mode: "inline" }))}
            />
          </div>
          {config.mode === "radial" && (
            <div className="quick-actions-choice-field">
              <span>{t("quickActions.radialLayout")}</span>
              <ChoiceCards
                label={t("quickActions.radialLayout")}
                value={config.radialLayout === "categories" ? "categories" : "flat"}
                onChange={(value) => persistStyle({ radialLayout: value })}
                options={cards([
                  { value: "flat", label: t("quickActions.radialLayout.flat") },
                  { value: "categories", label: t("quickActions.radialLayout.categories") },
                ], (radialLayout) => ({ radialLayout }))}
              />
            </div>
          )}
          {config.mode === "radial" && config.radialLayout !== "categories" && (
            <div className="quick-actions-choice-field">
              <span>{t("quickActions.radialPagination")}</span>
              <ChoiceCards
                label={t("quickActions.radialPagination")}
                value={config.radialPagination ? "pages" : "all"}
                onChange={(value) => persistStyle({ radialPagination: value === "pages" })}
                options={cards([
                  { value: "all", label: t("quickActions.radialPagination.all") },
                  { value: "pages", label: t("quickActions.radialPagination.pages") },
                ], (value) => ({ radialPagination: value === "pages" }))}
              />
            </div>
          )}
          {surface === "selection" &&
            ["inline", "favorite-menu"].includes(config.mode) && (
            <div className="quick-actions-choice-field">
              <span>{t("quickActions.selectionDisplay")}</span>
              <ChoiceCards
                label={t("quickActions.selectionDisplay")}
                value={config.selectionDisplay || "icon-label"}
                onChange={(selectionDisplay) => persist({ ...config, selectionDisplay })}
                options={cards([
                  { value: "icon-label", label: t("quickActions.selectionDisplay.iconLabel") },
                  { value: "icon-only", label: t("quickActions.selectionDisplay.iconOnly") },
                ], (selectionDisplay) => ({ selectionDisplay }))}
              />
              {config.mode === "inline" &&
                config.selectionDisplay !== "icon-only" && (
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
            </div>
          )}
        </div>

        {/* A row of its own, only for the layout it drives: the wheel never
            shows the favorite, and the field opening or growing never moves
            the controls above. */}
        {config.mode === "favorite-menu" && (
          <div className="quick-actions-editor-controls quick-actions-favorite-row">
            <label>
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
          </div>
        )}

        <div className="quick-actions-scope-status text-xs text-mail-text-muted">
          {/* No "customize" step: an edit on Current view stores what it changes. */}
          {viewDiffers && <>
            <span role="status">{t("quickActions.scope.differs")}</span>
            <button type="button" onClick={inheritAllViews}>{t("quickActions.scope.useGlobal")}</button>
          </>}
          {!isGlobal && !viewDiffers && <span role="status">{t("quickActions.scope.inherited")}</span>}
          {isGlobal && <button type="button" onClick={resetSurface}>{t("common.resetToDefault")}</button>}
        </div>

        <div className="quick-actions-entry-list">
          <AccountReorderList
            accounts={config.entries.map((entry) => ({ ...entry, email: getLabel(entry) }))}
            onReorder={reorderEntries}
            labels={{
              list: t("quickActions.actionList"),
              instructions: t("quickActions.reorderInstructions"),
              reorder: (name) => t("quickActions.reorder", { name }),
            }}
          >
            {(entry) => {
              const index = config.entries.findIndex((item) => item.id === entry.id);
              const entryColor = quickActionColorFor(entry, config.palette);
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
                  onClick={() => removeEntry(index)}
                >
                  <Trash2 size={15} aria-hidden="true" />
                </button>
                {config.palette === "custom" && (
                  <label className="quick-actions-color-control">
                    {t("quickActions.color")}
                    <input
                      type="color"
                      aria-label={`${t("quickActions.color")} ${entry.email}`}
                      value={entry.color || "#a0a0b6"}
                      onChange={(event) => updateEntry(index, { color: event.target.value })}
                    />
                    {!entry.color && <span>{t("quickActions.colorDefault")}</span>}
                    {entry.color && <button
                      type="button"
                      aria-label={`${t("quickActions.resetColor")} ${entry.email}`}
                      onClick={() => updateEntry(index, { color: undefined })}
                    >{t("quickActions.resetColor")}</button>}
                  </label>
                )}
              </div>;
            }}
          </AccountReorderList>
        </div>

        <div className="quick-actions-add-row" data-colored={!!quickActionColorFor(newEntry(addType), config.palette)}
          style={quickActionColorFor(newEntry(addType), config.palette) ? { "--quick-action-editor-color": quickActionColorFor(newEntry(addType), config.palette) } : undefined}>
          <label>
            {t("quickActions.action")}
            <select
              aria-label={t("quickActions.action")}
              value={addType}
              onChange={(event) => setAddType(event.target.value)}
            >
              {SURFACE_ACTIONS[surface].map((action) => (
                <option key={action} value={action}>
                  {t(LABELS[action] || "quickActions.title")}
                </option>
              ))}
            </select>
          </label>
          {addNeedsTag && (
            <div className="quick-actions-parameter">
              <label>
                {t("quickActions.param.label")}
                <select
                  aria-label={t("quickActions.param.label")}
                  value={tagId}
                  onChange={(event) => setTagId(event.target.value)}
                >
                  <option value="">
                    {t("quickActions.param.unavailable")}
                  </option>
                  {labels.map((label) => (
                    <option key={label.id} value={label.id}>
                      {label.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t("quickActions.param.labelName")}
                <input
                  value={newLabelName}
                  maxLength={80}
                  onChange={(event) => setNewLabelName(event.target.value)}
                />
              </label>
            </div>
          )}
          {addNeedsFolder && (
            <label>
              {t("quickActions.param.folder")}
              <select
                aria-label={t("quickActions.param.folder")}
                value={folder}
                onChange={(event) => setFolder(event.target.value)}
              >
                <option value="">{t("quickActions.param.folderPicker")}</option>
                {mailboxes.filter((item) =>
                  !item.noselect && item.path && item.path !== activeMailbox
                )
                  .map((item) => (
                    <option key={item.path} value={item.path}>
                      {item.name || item.path}
                    </option>
                  ))}
              </select>
            </label>
          )}
          {addNeedsTemplate && (
            <label>
              {t("quickActions.param.template")}
              <select
                aria-label={t("quickActions.param.template")}
                value={templateId}
                onChange={(event) => setTemplateId(event.target.value)}
              >
                <option value="">{t("quickActions.param.unavailable")}</option>
                {templates.map((item) => (
                  <option key={item.id} value={item.id}>{item.name}</option>
                ))}
              </select>
            </label>
          )}
          <button
            type="button"
            aria-label={t("quickActions.addAction")}
            disabled={!!addBlocked}
            onClick={addAction}
          >
            {t("quickActions.addAction")}
          </button>
        </div>

        <details className="quick-actions-default-order">
          <summary>{t("quickActions.defaultOrder")}</summary>
          <p className="text-xs text-mail-text-muted">{t("quickActions.defaultOrderDescription")}</p>
          <ol aria-label={t("quickActions.defaultOrder")}>
            {Object.entries(RADIAL_CATEGORIES).map(([category, actions]) => {
              const shown = actions.filter((action) => SURFACE_ACTIONS[surface].includes(action));
              if (!shown.length) return null;
              return <li key={category} data-category={category}>
                <strong>{t(`quickActions.category.${category}`)}</strong>
                <ol aria-label={t(`quickActions.category.${category}`)}>
                  {shown.map((action) => {
                    const Icon = ICONS[action];
                    return <li key={action} data-action={action}>
                      {Icon && <Icon size={13} aria-hidden="true" />}
                      {t(LABELS[action] || "quickActions.title")}
                    </li>;
                  })}
                </ol>
              </li>;
            })}
          </ol>
        </details>

        <section
          className="quick-actions-label-list"
          aria-labelledby="quick-actions-label-title"
        >
          <h5 id="quick-actions-label-title">
            {t("quickActions.localLabels")}
          </h5>
          {labels.map((label) => (
            <span key={label.id} className="local-mail-label">
              {label.name}
              <button
                type="button"
                aria-label={t("quickActions.removeLabel", {
                  label: label.name,
                })}
                onClick={() =>
                  deleteTag(label.id)}
              >
                ×
              </button>
            </span>
          ))}
        </section>
      </SettingsTabs>
    </div>
  );
}
