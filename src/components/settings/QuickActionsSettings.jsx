import React, { useEffect, useMemo, useState } from "react";
import {
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
import { useMailStore } from "../../stores/mailStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useQuickActionConfiguration } from "../../hooks/useQuickActionConfiguration";
import {
  DEFAULT_QUICK_ACTIONS,
  normalizeQuickActions,
  QUICK_ACTION_MODES,
  QUICK_ACTION_SURFACES,
  QUICK_ACTION_TYPES,
  quickActionScopeKey,
  resolveQuickActions,
} from "../../utils/quickActions";
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
  ],
  reader: QUICK_ACTION_TYPES.filter((action) => action !== "newMessage"),
};
const newEntry = (action, params = {}) => ({
  id: action === "tag"
    ? `tag:${params.labelId}`
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
  const resetScope = useSettingsStore((state) => state.resetQuickActionScope);
  const labels = useSettingsStore((state) => state.localMailLabels) ||
    EMPTY_ARRAY;
  const addLabel = useSettingsStore((state) => state.addLocalMailLabel);
  const removeLabel = useSettingsStore((state) => state.removeLocalMailLabel);
  const templates = useSettingsStore((state) => state.emailTemplates) ||
    EMPTY_ARRAY;
  const mailboxes = useMailStore((state) => state.mailboxes) || EMPTY_ARRAY;
  const activeAccountId = useMailStore((state) => state.activeAccountId);
  const activeMailbox = useMailStore((state) => state.activeMailbox);
  const accounts = useMailStore((state) => state.accounts) || EMPTY_ARRAY;
  const [surface, setSurfaceId] = useState("row");
  const [scopeChoices, setScopeChoices] = useState({
    row: "global",
    selection: "global",
    reader: "global",
  });
  const [newLabelName, setNewLabelName] = useState("");
  const [addType, setAddType] = useState("archive");
  const [tagId, setTagId] = useState("");
  const [folder, setFolder] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [previewStatus, setPreviewStatus] = useState("");
  const { scope } = useQuickActionConfiguration(surface);
  const scopeChoice = scopeChoices[surface] || "global";
  const scopeKey = quickActionScopeKey(scope);
  const isGlobal = scopeChoice === "global";
  const activeAccount = accounts.find((account) =>
    account.id === scope.accountId || account.id === activeAccountId
  );
  const scopeName = scope.view === "explorer"
    ? t("quickActions.scope.kind.explorer")
    : t(`quickActions.scope.kind.${scope.kind}`);
  const scopeDescription = [scopeName, activeAccount?.email, scope.mailbox]
    .filter(Boolean).join(" · ");
  const normalized = useMemo(() => normalizeQuickActions(quickActions), [
    quickActions,
  ]);
  const resolved = isGlobal
    ? { config: normalized.defaults[surface], inherited: false }
    : resolveQuickActions(normalized, surface, scope);
  const config = resolved.config;

  useEffect(() => {
    if (!SURFACE_ACTIONS[surface].includes(addType)) {
      setAddType(SURFACE_ACTIONS[surface][0]);
    }
    setPreviewStatus("");
  }, [surface, addType]);

  const persist = (next) => setSurface(surface, isGlobal ? null : scope, next);
  const resetSurface = () => persist(DEFAULT_QUICK_ACTIONS.defaults[surface]);
  const setMode = (mode) => persist({ ...config, mode });
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

  const addAction = () => {
    let params = {};
    if (addType === "tag") {
      let label = labels.find((item) => item.id === tagId);
      if (!label && newLabelName.trim()) label = addLabel(newLabelName.trim());
      if (!label) return;
      params = { labelId: label.id };
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
      return labels.find((item) => item.id === entry.params?.labelId)?.name ||
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
        <section
          className="quick-actions-preview"
          aria-labelledby="quick-actions-preview-title"
        >
          <h5 id="quick-actions-preview-title">{t("quickActions.preview")}</h5>
          <p className="text-xs text-mail-text-muted">
            {t("quickActions.previewDescription")}
          </p>
          <div
            className="quick-actions-preview-surface"
            role="group"
            aria-label={t(`quickActions.surface.${preview.name}`)}
          >
            {preview.name === "row" && (
              <div
                className="quick-actions-preview-row"
                data-radial={isRadialPreview}
              >
                <div className="quick-actions-preview-copy">
                  <span>
                    <strong>{t("quickActions.sample.sender")}</strong>
                    <small>{t("quickActions.sample.subject")}</small>
                  </span>
                  <time>10:42</time>
                </div>
                <QuickActions
                  surface="row"
                  config={preview.config}
                  descriptors={preview.descriptors}
                  preview
                  identity={`${surface}:${scopeChoice}:${config.mode}`}
                />
              </div>
            )}
            {preview.name === "selection" && (
              <div
                className="quick-actions-preview-selection selection-action-bar-inner"
                data-radial={isRadialPreview}
              >
                <div className="quick-actions-preview-copy">
                  <span>{t("quickActions.sample.selected")}</span>
                </div>
                <QuickActions
                  surface="selection"
                  config={preview.config}
                  descriptors={preview.descriptors}
                  display={config.selectionDisplay || "icon-label"}
                  inlineLimit={config.selectionDisplay === "icon-only"
                    ? undefined
                    : config.selectionActionLimit || 3}
                  className="quick-actions-selection"
                  preview
                  identity={`${surface}:${scopeChoice}:${config.mode}`}
                />
              </div>
            )}
            {preview.name === "reader" && (
              <div
                className="quick-actions-preview-reader"
                data-radial={isRadialPreview}
              >
                <div className="quick-actions-preview-copy">
                  <header>
                    <strong>{t("quickActions.sample.reader")}</strong>
                    <span>{t("quickActions.sample.sender")}</span>
                  </header>
                </div>
                <EmailActionBar
                  email={{
                    uid: -1,
                    _accountId: activeAccountId,
                    _mailbox: activeMailbox || "INBOX",
                    subject: t("quickActions.sample.reader"),
                    from: {
                      name: t("quickActions.sample.sender"),
                      address: "mira@example.test",
                    },
                    to: [{ address: "you@example.test" }],
                    flags: [],
                  }}
                  variant="single"
                  configOverride={preview.config}
                  preview
                  onActionPreview={() =>
                    setPreviewStatus(t("quickActions.previewResult"))}
                  onReply={() => {}}
                  onReplyAll={() => {}}
                  onForward={() => {}}
                  onArchive={() => {}}
                  onDelete={() => {}}
                  onDeleteEverywhere={() => {}}
                  onMove={() => {}}
                  onToggleRead={() => {}}
                  onToggleFlag={() => {}}
                  onSpam={() => {}}
                  onApplyLocalLabel={() => {}}
                  onReplyTemplate={() => {}}
                  onOpenInWindow={() => {}}
                  onViewSource={() => {}}
                  onExport={() => {}}
                  onToggleEmailTheme={() => {}}
                  isArchived={false}
                  isRead={false}
                  isLocalOnly={false}
                  isSentEmail={false}
                  singleRecipient={false}
                />
              </div>
            )}
          </div>
          <p role="status" className="text-xs text-mail-text-muted">
            {previewStatus || t("quickActions.sample.previewStatus")}
          </p>
        </section>

        <div className="quick-actions-editor-controls">
          <label>
            {t("quickActions.scope")}
            <select
              aria-label={t("quickActions.scope")}
              value={scopeChoice}
              onChange={(event) =>
                setScopeChoices((choices) => ({
                  ...choices,
                  [surface]: event.target.value,
                }))}
            >
              <option value="global">{t("quickActions.scope.global")}</option>
              <option value="current" disabled={!scopeKey}>
                {t("quickActions.scope.current")}
                {scopeKey ? ` · ${scopeDescription}` : ""}
              </option>
            </select>
          </label>
          <label>
            {t("quickActions.layout")}
            <select
              aria-label={t("quickActions.layout")}
              value={config.mode}
              onChange={(event) => setMode(event.target.value)}
            >
              {QUICK_ACTION_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {t(
                    `quickActions.layout.${
                      mode === "favorite-menu" ? "favoriteMenu" : mode
                    }`,
                  )}
                </option>
              ))}
            </select>
          </label>
        </div>

        {!isGlobal && (
          <div className="flex items-center gap-3 text-xs text-mail-text-muted">
            <span role="status">
              {resolved.inherited
                ? t("quickActions.scope.inherited")
                : t("quickActions.scope.current")}
            </span>
            {resolved.inherited
              ? (
                <button
                  type="button"
                  onClick={() => persist(config)}
                >
                  {t("quickActions.customizeScope")}
                </button>
              )
              : (
                <button
                  type="button"
                  onClick={() => resetScope(scope, surface)}
                >
                  {t("quickActions.inherit")}
                </button>
              )}
          </div>
        )}
        {isGlobal && (
          <button type="button" onClick={resetSurface}>
            {t("common.resetToDefault")}
          </button>
        )}

        <div className="quick-actions-editor-controls">
          <label>
            {t("quickActions.palette")}
            <select
              aria-label={t("quickActions.palette")}
              value={config.palette}
              onChange={(event) =>
                persist({ ...config, palette: event.target.value })}
            >
              {["neutral", "semantic", "custom"].map((palette) => (
                <option key={palette} value={palette}>
                  {t(`quickActions.palette.${palette}`)}
                </option>
              ))}
            </select>
          </label>
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
            <label className="quick-actions-checkbox">
              <input
                type="checkbox"
                checked={!!config.radialPagination}
                onChange={(event) =>
                  persist({
                    ...config,
                    radialPagination: event.target.checked,
                  })}
              />
              {t("quickActions.radialPagination")}
            </label>
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

        <ol className="quick-actions-entry-list">
          {config.entries.map((entry, index) => (
            <li key={entry.id}>
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
              {config.palette === "custom" && (
                <label className="quick-actions-color-control">
                  {t("quickActions.color")}
                  <input
                    type="color"
                    aria-label={`${t("quickActions.color")} ${getLabel(entry)}`}
                    value={entry.color || "#a0a0b6"}
                    onChange={(event) =>
                      updateEntry(index, { color: event.target.value })}
                  />
                  {!entry.color && (
                    <span>{t("quickActions.colorDefault")}</span>
                  )}
                  {entry.color && (
                    <button
                      type="button"
                      aria-label={`${t("quickActions.resetColor")} ${
                        getLabel(entry)
                      }`}
                      onClick={() => updateEntry(index, { color: undefined })}
                    >
                      {t("quickActions.resetColor")}
                    </button>
                  )}
                </label>
              )}
              <button
                type="button"
                aria-label={`${t("quickActions.removeAction")} ${
                  getLabel(entry)
                }`}
                onClick={() => removeEntry(index)}
              >
                {t("quickActions.removeAction")}
              </button>
            </li>
          ))}
        </ol>

        <div className="quick-actions-add-row">
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
                  removeLabel(label.id)}
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
