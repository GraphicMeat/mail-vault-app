import React, { useEffect, useMemo, useState } from "react";
import {
  AlarmClock,
  Archive,
  ArchiveRestore,
  Code,
  ExternalLink,
  FileText,
  FolderInput,
  Forward,
  ImageDown,
  Mail,
  MailOpen,
  MailPlus,
  Moon,
  Reply,
  ReplyAll,
  ShieldAlert,
  ShieldX,
  Star,
  StarOff,
  Tag,
  Trash2,
} from "lucide-react";
import { QuickActions } from "../QuickActions";
import { EmailActionBar } from "../email/EmailActionBar";
import { SettingsTabs } from "./SettingsTabs";
import { SegmentedChoice } from "../ui/SegmentedChoice";
import { useMailStore } from "../../stores/mailStore";
import { useTagStore } from "../../stores/tagStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useQuickActionConfiguration } from "../../hooks/useQuickActionConfiguration";
import {
  DEFAULT_QUICK_ACTIONS,
  normalizeQuickActions,
  isQuickActionStyleLinked,
  QUICK_ACTION_MODES,
  QUICK_ACTION_SURFACES,
  QUICK_ACTION_TYPES,
  quickActionScopeKey,
  resolveQuickActions,
} from "../../utils/quickActions";
import { quickActionColorFor } from "../../utils/quickActionColors";
import { formatTime } from "../../utils/dateFormat";
import { useT } from "../../i18n/index.js";
import "../../styles/settings-usability.css";

const ICONS = {
  archive: Archive,
  unarchive: ArchiveRestore,
  delete: Trash2,
  deleteServer: Trash2,
  deleteEverywhere: ShieldX,
  toggleRead: MailOpen,
  markRead: MailOpen,
  markUnread: Mail,
  star: Star,
  unstar: StarOff,
  tag: Tag,
  move: FolderInput,
  spam: ShieldAlert,
  reply: Reply,
  replyAll: ReplyAll,
  forward: Forward,
  replyTemplate: FileText,
  export: ImageDown,
  newMessage: MailPlus,
  open: ExternalLink,
  source: Code,
  theme: Moon,
  snooze: AlarmClock,
};
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
};
const DESTRUCTIVE = new Set(["delete", "deleteServer", "deleteEverywhere"]);
const EMPTY_ARRAY = Object.freeze([]);
const SURFACE_ACTIONS = {
  row: QUICK_ACTION_TYPES.filter((action) =>
    !["open", "source", "theme"].includes(action)
  ),
  selection: [
    "archive",
    "unarchive",
    "delete",
    "deleteServer",
    "deleteEverywhere",
    "toggleRead",
    "markRead",
    "markUnread",
    "star",
    "unstar",
    "tag",
    "move",
    "spam",
    "export",
    "snooze",
  ],
  reader: QUICK_ACTION_TYPES.filter((action) => action !== "newMessage"),
};
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

function QuickActionsSettingsPreview({
  preview, isRadialPreview, surface, scopeChoice, config,
  activeAccountId, activeMailbox, onPreview, status,
}) {
  const t = useT();
  const identity = `${surface}:${scopeChoice}:${config.mode}`;
  return <section className="quick-actions-preview" aria-labelledby="quick-actions-preview-title">
    <h5 id="quick-actions-preview-title">{t("quickActions.preview")}</h5>
    <p className="text-xs text-mail-text-muted">{t("quickActions.previewDescription")}</p>
    <div className="quick-actions-preview-surface" role="group"
      aria-label={t(`quickActions.surface.${preview.name}`)}>
      {preview.name === "row" && <div className="quick-actions-preview-row" data-radial={isRadialPreview}>
        <div className="quick-actions-preview-copy">
          <span><strong>{t("quickActions.sample.sender")}</strong><small>{t("quickActions.sample.subject")}</small></span>
          <time>{formatTime(new Date(2026, 1, 25, 10, 42))}</time>
        </div>
        <QuickActions surface="row" config={preview.config} descriptors={preview.descriptors} preview identity={identity} />
      </div>}
      {preview.name === "selection" && <div className="quick-actions-preview-selection selection-action-bar-inner" data-radial={isRadialPreview}>
        <div className="quick-actions-preview-copy"><span>{t("quickActions.sample.selected")}</span></div>
        <QuickActions surface="selection" config={preview.config} descriptors={preview.descriptors}
          display={config.selectionDisplay || "icon-label"}
          inlineLimit={config.selectionDisplay === "icon-only" ? undefined : config.selectionActionLimit || 3}
          className="quick-actions-selection" preview identity={identity} />
      </div>}
      {preview.name === "reader" && <div className="quick-actions-preview-reader" data-radial={isRadialPreview}>
        <div className="quick-actions-preview-copy"><header><strong>{t("quickActions.sample.reader")}</strong><span>{t("quickActions.sample.sender")}</span></header></div>
        <EmailActionBar
          email={{ uid: -1, _accountId: activeAccountId, _mailbox: activeMailbox || "INBOX", subject: t("quickActions.sample.reader"), from: { name: t("quickActions.sample.sender"), address: "mira@example.test" }, to: [{ address: "you@example.test" }], flags: [] }}
          variant="single" configOverride={preview.config} preview onActionPreview={onPreview}
          onReply={() => {}} onReplyAll={() => {}} onForward={() => {}} onArchive={() => {}} onDelete={() => {}} onDeleteEverywhere={() => {}}
          onMove={() => {}} onToggleRead={() => {}} onToggleFlag={() => {}} onSpam={() => {}} onApplyLocalLabel={() => {}} onReplyTemplate={() => {}}
          onOpenInWindow={() => {}} onViewSource={() => {}} onExport={() => {}} onToggleEmailTheme={() => {}}
          isArchived={false} isRead={false} isLocalOnly={false} isSentEmail={false} singleRecipient={false}
        />
      </div>}
    </div>
    <p role="status" className="text-xs text-mail-text-muted">{status || t("quickActions.sample.previewStatus")}</p>
  </section>;
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
  const [previewStatus, setPreviewStatus] = useState("");
  const { scope } = useQuickActionConfiguration(surface);
  const scopeKey = quickActionScopeKey(scope);
  const normalized = useMemo(() => normalizeQuickActions(quickActions), [
    quickActions,
  ]);
  const scopeChoice = scopeChoices[surface] ||
    (scopeKey && normalized.overrides[scopeKey]?.[surface] ? "current" : "global");
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
    setPreviewStatus("");
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
    });
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
  const reorderEntry = (index, delta) => {
    const nextIndex = Math.max(
      0,
      Math.min(config.entries.length - 1, index + delta),
    );
    if (nextIndex === index) return;
    const entries = [...config.entries];
    [entries[index], entries[nextIndex]] = [entries[nextIndex], entries[index]];
    persist({ ...config, entries });
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
    persist({ ...config, entries: [...config.entries, item] });
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
  const getDescriptors = (entries) =>
    entries.map((entry) => {
      const missingTemplate = entry.action === "replyTemplate" &&
        !templates.some((item) => item.id === entry.params?.templateId);
      const missingFolder = entry.action === "move" && entry.params?.mailbox &&
        !mailboxes.some((item) => item.path === entry.params.mailbox);
      return {
        id: entry.id,
        action: entry.action,
        label: getLabel(entry),
        Icon: ICONS[entry.action],
        disabled: missingTemplate || missingFolder,
        tone: DESTRUCTIVE.has(entry.action)
          ? "danger"
          : entry.action === "archive"
          ? "positive"
          : undefined,
        isDestructive: DESTRUCTIVE.has(entry.action),
        onActivate: () => setPreviewStatus(t("quickActions.previewResult")),
      };
    });

  const preview = {
    name: surface,
    config,
    descriptors: getDescriptors(config.entries),
  };
  const isRadialPreview = config.mode === "radial";
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
      <SettingsTabs
        tabs={QUICK_ACTION_SURFACES.map((name) => ({
          id: name,
          label: t(`quickActions.surface.${name}`),
        }))}
        value={surface}
        onChange={setSurfaceId}
        label={t("quickActions.surface")}
      >
        <div className="quick-actions-editor-controls quick-actions-choice-controls">
          <div className="quick-actions-choice-field">
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
          <div className="quick-actions-choice-field">
            <span>{t("quickActions.layout")}</span>
            <SegmentedChoice
              label={t("quickActions.layout")}
              value={config.mode}
              onChange={setMode}
              options={QUICK_ACTION_MODES.map((mode) => ({
                value: mode,
                label: t(`quickActions.layout.${mode === "favorite-menu" ? "favoriteMenu" : mode}`),
              }))}
            />
          </div>
        </div>

        <div className="quick-actions-editor-controls quick-actions-choice-controls">
          <div className="quick-actions-choice-field">
            <span>{t("quickActions.palette")}</span>
            <SegmentedChoice
              label={t("quickActions.palette")}
              value={config.palette}
              onChange={(palette) => persistStyle({ palette })}
              options={["neutral", "semantic", "custom"].map((palette) => ({ value: palette, label: t(`quickActions.palette.${palette}`) }))}
            />
          </div>
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
          {config.mode === "favorite-menu" && (
            <label>
              {t("quickActions.favorite")}
              <select
                aria-label={t("quickActions.favorite")}
                value={config.favoriteId || ""}
                onChange={(event) =>
                  persist({
                    ...config,
                    favoriteId: event.target.value || null,
                  })}
              >
                <option value="">{t("quickActions.param.autoFavorite")}</option>
                {config.entries.map((item) => (
                  <option key={item.id} value={item.id}>
                    {getLabel(item)}
                  </option>
                ))}
              </select>
            </label>
          )}
          {config.mode === "radial" && (
            <div className="quick-actions-choice-field">
              <span>{t("quickActions.radialPagination")}</span>
              <SegmentedChoice
                label={t("quickActions.radialPagination")}
                value={config.radialPagination ? "pages" : "all"}
                onChange={(value) => persistStyle({ radialPagination: value === "pages" })}
                options={[
                  { value: "all", label: t("quickActions.radialPagination.all") },
                  { value: "pages", label: t("quickActions.radialPagination.pages") },
                ]}
              />
            </div>
          )}
          {surface === "selection" &&
            ["inline", "favorite-menu"].includes(config.mode) && (
            <>
              <label>
                {t("quickActions.selectionDisplay")}
                <select
                  aria-label={t("quickActions.selectionDisplay")}
                  value={config.selectionDisplay || "icon-label"}
                  onChange={(event) =>
                    persist({
                      ...config,
                      selectionDisplay: event.target.value,
                    })}
                >
                  <option value="icon-label">
                    {t("quickActions.selectionDisplay.iconLabel")}
                  </option>
                  <option value="icon-only">
                    {t("quickActions.selectionDisplay.iconOnly")}
                  </option>
                </select>
              </label>
              {config.mode === "inline" &&
                config.selectionDisplay !== "icon-only" && (
                <label>
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
            </>
          )}
        </div>

        <div className="quick-actions-scope-status text-xs text-mail-text-muted">
          {!isGlobal && <>
            <span role="status">{resolved.inherited ? t("quickActions.scope.inherited") : t("quickActions.scope.current")}</span>
            {/* Pinned: once the override is gone the fallback would jump to All views. */}
            <button type="button" onClick={() => { pickScope("current"); resolved.inherited ? persist(config) : resetScope(scope, surface); }}>
              {resolved.inherited ? t("quickActions.customizeScope") : t("quickActions.inherit")}
            </button>
          </>}
          {isGlobal && <button type="button" onClick={resetSurface}>{t("common.resetToDefault")}</button>}
        </div>

        <QuickActionsSettingsPreview
          preview={preview}
          isRadialPreview={isRadialPreview}
          surface={surface}
          scopeChoice={scopeChoice}
          config={config}
          activeAccountId={activeAccountId}
          activeMailbox={activeMailbox}
          onPreview={() => setPreviewStatus(t("quickActions.previewResult"))}
          status={previewStatus}
        />

        <ol className="quick-actions-entry-list">
          {config.entries.map((entry, index) => {
            const entryColor = quickActionColorFor(entry, config.palette);
            return <li key={entry.id} data-colored={!!entryColor}
              style={entryColor ? { "--quick-action-editor-color": entryColor } : undefined}>
              <span className="quick-actions-entry-name">
                {getLabel(entry)}
              </span>
              <button
                type="button"
                aria-label={`${t("quickActions.moveUp")} ${getLabel(entry)}`}
                disabled={index === 0}
                onClick={() => reorderEntry(index, -1)}
              >
                ↑
              </button>
              <button
                type="button"
                aria-label={`${t("quickActions.moveDown")} ${getLabel(entry)}`}
                disabled={index === config.entries.length - 1}
                onClick={() => reorderEntry(index, 1)}
              >
                ↓
              </button>
              <button
                type="button"
                aria-label={`${t("quickActions.removeAction")} ${
                  getLabel(entry)
                }`}
                onClick={() => removeEntry(index)}
              >
                {t("quickActions.removeAction")}
              </button>
              {config.palette === "custom" && (
                <label className="quick-actions-color-control">
                  {t("quickActions.color")}
                  <input
                    type="color"
                    aria-label={`${t("quickActions.color")} ${getLabel(entry)}`}
                    value={entry.color || "#a0a0b6"}
                    onChange={(event) => updateEntry(index, { color: event.target.value })}
                  />
                  {!entry.color && <span>{t("quickActions.colorDefault")}</span>}
                  {entry.color && <button
                    type="button"
                    aria-label={`${t("quickActions.resetColor")} ${getLabel(entry)}`}
                    onClick={() => updateEntry(index, { color: undefined })}
                  >{t("quickActions.resetColor")}</button>}
                </label>
              )}
            </li>;
          })}
        </ol>

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
