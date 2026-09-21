import { Button } from "./ui/Button";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useSelectionStore } from "../stores/selectionStore";
import { useMessageListStore } from "../stores/messageListStore";
import { useSearchStore } from "../stores/searchStore";
import {
  Archive,
  ArchiveRestore,
  FolderSymlink,
  ImageDown,
  Mail,
  MailOpen,
  ShieldAlert,
  ShieldX,
  Star,
  StarOff,
  Tag,
  Trash2,
  X,
} from "lucide-react";
import { MoveToFolderDropdown } from "./MoveToFolderDropdown";
import { vaultClause } from "../utils/custodyCopy";
import { useMailStore } from "../stores/mailStore";
import { useExportStore } from "../stores/exportStore";
import { QuickActions } from "./QuickActions";
import { useQuickActionConfiguration } from "../hooks/useQuickActionConfiguration";
import { useSettingsStore } from "../stores/settingsStore";
import {
  resolveEmailLocation,
  selectionKey,
} from "../stores/slices/unifiedHelpers";
import { getAccountCacheMailboxes } from "../services/cacheManager";
import { DeleteConfirmModal } from "./DeleteConfirmModal";
import { resolveQuickActionSelectionTarget } from "../utils/quickActions";
import { t, useT } from "../i18n/index.js";

const EMPTY_ARRAY = Object.freeze([]);

export function SelectionActionBar() {
  const t = useT();
  const { config } = useQuickActionConfiguration("selection");
  const selectedEmailIds = useSelectionStore((s) => s.selectedEmailIds);
  const archivedEmailIds = useMessageListStore((s) => s.archivedEmailIds);
  const clearSelection = useSelectionStore((s) => s.clearSelection);
  const saveSelectedLocally = useSelectionStore((s) => s.saveSelectedLocally);
  const markSelectedAsRead = useSelectionStore((s) => s.markSelectedAsRead);
  const markSelectedAsUnread = useSelectionStore((s) => s.markSelectedAsUnread);
  const deleteSelectedFromServer = useSelectionStore((s) =>
    s.deleteSelectedFromServer
  );
  const purgeSelectedEverywhere = useSelectionStore((s) =>
    s.purgeSelectedEverywhere
  );
  const removeLocalEmail = useSelectionStore((s) => s.removeLocalEmail);
  const getSelectionSummary = useSelectionStore((s) => s.getSelectionSummary);
  const localLabels = useSettingsStore((s) => s.localMailLabels) || EMPTY_ARRAY;
  const applyLocalMailLabel = useSettingsStore((s) => s.applyLocalMailLabel);
  const sortedEmails = useMailStore((s) => s.sortedEmails);
  const serverEmails = useMailStore((s) => s.emails);
  const localEmails = useMailStore((s) => s.localEmails);
  const sentEmails = useMailStore((s) => s.sentEmails);
  // A search hit can name a message no loaded list holds. Without this pool a
  // key ticked in the search results resolved to no row at all, so the bar
  // read the selection as unresolvable and greyed out mark read/unread,
  // delete from server and delete everywhere over a selection the user had
  // just made.
  const searchResults = useSearchStore((s) => s.searchResults);

  // Which delete was requested — 'server' or 'everywhere' — so a single
  // popover can show the right confirmation copy for whichever button
  // triggered it. null means the popover is closed.
  const [deleteMode, setDeleteMode] = useState(null);
  const [showMoveDropdown, setShowMoveDropdown] = useState(false);
  const [moveLeft, setMoveLeft] = useState(0);
  const moveButtonRef = useRef(null);
  const barRef = useRef(null);
  const selectionLabelRef = useRef(null);
  const confirmationReturnRef = useRef(null);
  const [inlineAvailableWidth, setInlineAvailableWidth] = useState(null);

  const hasSelection = selectedEmailIds.size > 0;

  // Dismiss delete confirmation when selection changes
  useEffect(() => {
    setDeleteMode(null);
  }, [selectedEmailIds]);

  const summary = useMemo(() => {
    if (!hasSelection) return { threads: 0, emails: 0 };
    return getSelectionSummary();
  }, [hasSelection, selectedEmailIds, getSelectionSummary]);

  // Parse a selection key (may be "accountId:uid" in unified mode) to extract raw uid
  const parseKey = (key) => {
    const s = String(key);
    const i = s.indexOf(":");
    if (i > 0) {
      const raw = s.slice(i + 1);
      return /^\d+$/.test(raw) ? Number(raw) : raw;
    }
    return key;
  };

  // The bar holds selection KEYS, not messages, so the rows are resolved back
  // out of the store — by the same key the checkbox wrote. Matching on uid
  // alone would pull a second account's message into a unified selection.
  // A key the render window cannot resolve is simply not in the list, and the
  // dialog's own heading counts what it is actually about to export.
  const exportSelected = () => {
    const state = useMailStore.getState();
    const { sortedEmails = [] } = state;
    const messages = sortedEmails.filter((e) =>
      selectedEmailIds.has(selectionKey(e, state))
    );
    if (messages.length) useExportStore.getState().openExport({ messages });
  };

  // Determine archive state of selected emails. The counts, not just the
  // booleans: the delete confirmation says how many of them the vault
  // actually holds, and it must agree with what gates Archive/Unarchive.
  const { hasArchived, hasUnarchived, archivedCount, totalCount } = useMemo(
    () => {
      let archived = 0;
      let unarchived = 0;
      for (const key of selectedEmailIds) {
        if (archivedEmailIds.has(parseKey(key))) archived++;
        else unarchived++;
      }
      return {
        hasArchived: archived > 0,
        hasUnarchived: unarchived > 0,
        archivedCount: archived,
        totalCount: archived + unarchived,
      };
    },
    [selectedEmailIds, archivedEmailIds],
  );

  // `report` for the actions that destroy a message: those refuse a row they
  // cannot place (which account, which folder) rather than guess, and the
  // whole selection stays put. Console-only, that reads as a button that does
  // nothing. Mark and save skip such a row instead, so they keep the log line.
  const handleAction = async (action, { report = false } = {}) => {
    try {
      await action();
    } catch (e) {
      console.error("Selection action failed:", e);
      if (report) {
        useMailStore.setState({
          error: t("list.deleteFailed", { err: e?.message || e }),
        });
      }
    }
  };

  // The dropdown cannot live inside the bar's inner div: that div scrolls
  // horizontally on a narrow window (`overflow-x-auto`), and per CSS an
  // auto overflow-x makes overflow-y auto too, so the box above the bar was
  // clipped away: it mounted, measured non-zero, and nothing on screen took
  // the click. It hangs off the fixed wrapper instead, like the delete
  // popover, and carries the Move button's own offset as its `left`.
  const toggleMoveDropdown = () => {
    if (showMoveDropdown) {
      setShowMoveDropdown(false);
      return;
    }
    const btn = moveButtonRef.current?.getBoundingClientRect();
    const bar = barRef.current?.getBoundingClientRect();
    setMoveLeft(btn && bar ? btn.left - bar.left : 0);
    setShowMoveDropdown(true);
  };

  const handleDelete = () => {
    setDeleteMode("server");
  };

  const handleDeleteEverywhere = () => {
    setDeleteMode("everywhere");
  };
  const handleDeleteUnarchive = () => setDeleteMode("unarchive");

  const confirmDelete = () => {
    const mode = deleteMode;
    setDeleteMode(null);
    if (mode === "unarchive") handleAction(handleUnarchive, { report: true });
    else {handleAction(
        mode === "everywhere"
          ? purgeSelectedEverywhere
          : deleteSelectedFromServer,
        { report: true },
      );}
  };

  const handleUnarchive = async () => {
    const state = useMailStore.getState();
    const selected = selectedRows.filter((email) => email.isArchived);
    for (const email of selected) {
      const location = resolveEmailLocation(email, state);
      if (!location) continue;
      try {
        await removeLocalEmail(email.uid, location);
      } catch (e) {
        console.error(`Failed to unarchive email ${email.uid}:`, e);
      }
    }
    clearSelection();
  };

  // Lead with the message count, not the conversation count: every button on
  // this bar acts per message, and so does the bulk modal — which reads "65
  // emails selected" off the same selection. Leading with threads made the two
  // disagree on screen ("52 selected (65 emails)") about a run that touches 65.
  const selectionLabel = summary.threads === summary.emails
    ? t("selection.selected", { summary: summary.emails })
    : t("selection.selectedConversations", {
      summary: summary.emails,
      summary2: summary.threads,
    });

  useEffect(() => {
    if (!hasSelection || !barRef.current) return undefined;
    const measure = () => {
      const width = barRef.current?.getBoundingClientRect().width || 0;
      const labelWidth =
        selectionLabelRef.current?.getBoundingClientRect().width || 0;
      setInlineAvailableWidth(Math.max(34, width - labelWidth - 86));
    };
    measure();
    const observer = typeof ResizeObserver === "function"
      ? new ResizeObserver(measure)
      : null;
    observer?.observe(barRef.current);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [hasSelection, selectionLabel]);

  // What the confirmation is about to destroy, in the same two units as the
  // label above. A conversation row is one checkbox over several messages, so
  // a bare message count reads as wrong to whoever ticked two boxes — say both
  // numbers whenever they differ.
  const deleteScope = summary.threads === summary.emails
    ? t("common.emailCount", { count: summary.emails })
    : t("selection.emailsInConversations", {
      emails: summary.emails,
      count: summary.threads,
    });

  const selectedRows = useMemo(() => {
    const state = useMailStore.getState();
    const allRows = [
      ...(sortedEmails || []),
      ...(serverEmails || []),
      ...(localEmails || []),
      ...(sentEmails || []),
      ...(searchResults || []),
    ];
    const seen = new Set();
    return allRows.filter((email) => {
      const key = selectionKey(email, state);
      if (!selectedEmailIds.has(key) || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [selectedEmailIds, sortedEmails, serverEmails, localEmails, sentEmails, searchResults]);
  const allSelectionRows = useMemo(
    () => [
      ...(sortedEmails || []),
      ...(serverEmails || []),
      ...(localEmails || []),
      ...(sentEmails || []),
      ...(searchResults || []),
    ],
    [sortedEmails, serverEmails, localEmails, sentEmails, searchResults],
  );
  const selectionTarget = resolveQuickActionSelectionTarget(
    [...selectedEmailIds],
    allSelectionRows,
    useMailStore.getState(),
  );
  const selectedRowKeys = new Set(
    selectedRows.map((email) => selectionKey(email, useMailStore.getState())),
  );
  const selectionIsFullyResolved =
    selectedRowKeys.size === selectedEmailIds.size &&
    [...selectedEmailIds].every((key) => selectedRowKeys.has(key));
  const hasUnread = selectedRows.some((email) =>
    !email.flags?.includes("\\Seen")
  );
  const hasRead = selectedRows.some((email) => email.flags?.includes("\\Seen"));
  const locations = selectedRows.map((email) =>
    resolveEmailLocation(email, useMailStore.getState())
  );
  const resolved = selectionIsFullyResolved && locations.length > 0 &&
    locations.every(Boolean);
  const singleAccount = !!selectionTarget;
  const oneMailbox = !!selectionTarget?.mailbox;
  const allServerBacked = selectionIsFullyResolved && selectedRows.length > 0 &&
    selectedRows.every((email) =>
      email.source !== "local-only" && !email._insightsReadOnly &&
      !email._insightsNoServerActions
    );
  const junkPaths = [
    ...new Set(locations.map((location) => {
      if (!location) return null;
      const state = useMailStore.getState();
      const mailboxes = location.accountId === state.activeAccountId
        ? state.mailboxes
        : getAccountCacheMailboxes(location.accountId);
      return mailboxes?.find((folder) =>
        String(folder.specialUse || "").toLowerCase() === "\\junk"
      )?.path || null;
    })),
  ];
  const selectionJunkPath = singleAccount && junkPaths.length === 1
    ? junkPaths[0]
    : null;
  const selectionKeys = [...selectedEmailIds];
  const selectionDescriptors = config.entries.map((entry) => {
    const label = entry.action === "tag"
      ? localLabels.find((item) => item.id === entry.params?.labelId)?.name ||
        t("quickActions.action.tag")
      : entry.action === "move" && entry.params?.mailbox
      ? `${t("selection.move")}: ${entry.params.mailbox}`
      : entry.action === "spam"
      ? t("quickActions.action.spam")
      : entry.action === "toggleRead"
      ? (hasUnread ? t("selection.markRead") : t("selection.markUnread"))
      : entry.action === "deleteServer"
      ? t("rowMenu.deleteServer")
      : entry.action === "delete"
      ? t("common.delete")
      : entry.action === "deleteEverywhere"
      ? t("selection.deleteEverywhere")
      : entry.action === "export"
      ? t("selection.exportSelected")
      : entry.action === "archive"
      ? t("common.archive")
      : entry.action === "unarchive"
      ? t("selection.unarchive")
      : entry.action === "markRead"
      ? t("selection.markRead")
      : entry.action === "markUnread"
      ? t("selection.markUnread")
      : entry.action === "star"
      ? t("rowMenu.star")
      : entry.action === "unstar"
      ? t("rowMenu.unstar")
      : entry.action === "move"
      ? t("selection.moveFolder")
      : t("quickActions.title");
    const disabledAction = [
      "open",
      "source",
      "theme",
      "reply",
      "replyAll",
      "forward",
      "replyTemplate",
      "newMessage",
    ].includes(entry.action) ||
      entry.action === "archive" && !hasUnarchived ||
      entry.action === "unarchive" &&
        (!hasArchived || !selectionIsFullyResolved ||
          !locations.every(Boolean)) ||
      ["delete", "deleteServer"].includes(entry.action) && !allServerBacked ||
      entry.action === "deleteEverywhere" && !resolved ||
      entry.action === "markRead" &&
        (!selectionIsFullyResolved || !hasUnread) ||
      entry.action === "toggleRead" &&
        (!selectionIsFullyResolved || (!hasUnread && !hasRead)) ||
      entry.action === "markUnread" &&
        (!selectionIsFullyResolved || !hasRead) ||
      entry.action === "star" &&
        !selectedRows.some((email) => !email.flags?.includes("\\Flagged")) ||
      entry.action === "unstar" &&
        !selectedRows.some((email) => email.flags?.includes("\\Flagged")) ||
      entry.action === "move" &&
        (!allServerBacked || !singleAccount || (entry.params?.mailbox && (
          (entry.params.accountId &&
            entry.params.accountId !== selectionTarget.accountId) ||
          locations.some((location) =>
            location.accountId !== selectionTarget.accountId
          ) ||
          !(selectionTarget &&
            (selectionTarget.accountId ===
                useMailStore.getState().activeAccountId
              ? useMailStore.getState().mailboxes
              : getAccountCacheMailboxes(selectionTarget.accountId))?.some(
                (folder) =>
                  !folder.noselect &&
                  (folder.path || folder.name) === entry.params.mailbox,
              ))
        ))) ||
      entry.action === "spam" && (!allServerBacked || !selectionJunkPath) ||
      entry.action === "tag" &&
        (!localLabels.some((item) => item.id === entry.params?.labelId) ||
          !resolved);
    const Icon = {
      archive: Archive,
      unarchive: ArchiveRestore,
      delete: Trash2,
      deleteServer: Trash2,
      deleteEverywhere: ShieldX,
      export: ImageDown,
      move: FolderSymlink,
      toggleRead: hasUnread ? MailOpen : Mail,
      markRead: MailOpen,
      markUnread: Mail,
      star: Star,
      unstar: StarOff,
      tag: Tag,
      spam: ShieldAlert,
    }[entry.action];
    return {
      id: entry.id,
      action: entry.action,
      label,
      Icon,
      disabled: !!disabledAction,
      tone:
        ["delete", "deleteServer", "deleteEverywhere"].includes(entry.action)
          ? "danger"
          : ["archive", "unarchive"].includes(entry.action)
          ? "positive"
          : undefined,
      isDestructive: ["delete", "deleteServer", "deleteEverywhere"].includes(
        entry.action,
      ),
      buttonRef: entry.action === "move" ? moveButtonRef : undefined,
      expanded: entry.action === "move" ? showMoveDropdown : undefined,
      restoreFocus: ![
        "move",
        "delete",
        "deleteServer",
        "deleteEverywhere",
        "unarchive",
      ].includes(entry.action),
      onActivate: async () => {
        if (entry.action === "markRead") await handleAction(markSelectedAsRead);
        else if (entry.action === "markUnread") {
          await handleAction(markSelectedAsUnread);
        } else if (entry.action === "toggleRead") {
          await handleAction(
            hasUnread ? markSelectedAsRead : markSelectedAsUnread,
          );
        } else if (entry.action === "archive") {
          await handleAction(saveSelectedLocally);
        } else if (entry.action === "unarchive") handleDeleteUnarchive();
        else if (entry.action === "delete" || entry.action === "deleteServer") {
          handleDelete();
        } else if (entry.action === "deleteEverywhere") {
          handleDeleteEverywhere();
        } else if (entry.action === "export") exportSelected();
        else if (entry.action === "move" && entry.params?.mailbox) {
          await handleAction(
            () =>
              useMailStore.getState().moveEmails(
                selectionKeys,
                entry.params.mailbox,
              ),
            { report: true },
          );
        } else if (entry.action === "move") toggleMoveDropdown();
        else if (entry.action === "spam") {
          await handleAction(() =>
            useMailStore.getState().moveEmails(
              selectionKeys,
              selectionJunkPath,
            ), { report: true });
        } else if (entry.action === "star" || entry.action === "unstar") {
          await handleAction(() =>
            useMailStore.getState().setSelectedFlagged(entry.action === "star")
          );
        } else if (entry.action === "tag") {
          selectedRows.forEach((email, index) =>
            locations[index] &&
            applyLocalMailLabel(email, locations[index], entry.params.labelId)
          );
        }
      },
    };
  });

  return (
    <AnimatePresence>
      {hasSelection && (
        <motion.div
          key="selection-bar"
          ref={barRef}
          initial={{ y: 80, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 80, opacity: 0 }}
          transition={{ type: "spring", damping: 25, stiffness: 300 }}
          className="fixed inset-x-0 bottom-4 sm:bottom-6 z-40 flex justify-center px-3 pointer-events-none"
        >
          <div className="flex items-center gap-1 px-2 py-1.5 bg-mail-surface border border-mail-strong
                         rounded-xl
                         max-w-[calc(100vw-1.5rem)] min-w-0 pointer-events-auto">
            {/* Selection count */}
            <span
              ref={selectionLabelRef}
              className="text-sm font-medium text-mail-text px-3 whitespace-nowrap"
            >
              {selectionLabel}
            </span>

            <QuickActions
              surface="selection"
              config={config}
              descriptors={selectionDescriptors}
              display={config.selectionDisplay || "icon-label"}
              inlineLimit={config.selectionDisplay === "icon-only"
                ? undefined
                : config.selectionActionLimit || 3}
              inlineAvailableWidth={inlineAvailableWidth}
              className="quick-actions-selection min-w-0"
              identity={[...selectedEmailIds].join("|")}
              onActionStart={(event, trigger, entry) => {
                if (
                  ["delete", "deleteServer", "deleteEverywhere", "unarchive"]
                    .includes(entry.action)
                ) {
                  confirmationReturnRef.current = trigger ||
                    event.currentTarget;
                }
              }}
            />

            <div className="w-px h-6 bg-mail-border" />

            {/* Clear */}
            <Button
              variant="ghost"
              icon
              size="md"
              onClick={clearSelection}
              title={t("selection.clearSelection")}
            >
              <X size={16} className="text-mail-text-muted" />
            </Button>
          </div>

          {/* Move dropdown: a sibling of the scrolling bar, not a child of it */}
          {showMoveDropdown && (
            <div
              className="absolute bottom-full mb-2 pointer-events-auto"
              style={{ left: moveLeft }}
            >
              <MoveToFolderDropdown
                uids={[...selectedEmailIds]}
                accountId={singleAccount ? locations[0]?.accountId : null}
                currentMailbox={oneMailbox ? locations[0]?.mailbox : null}
                onClose={() => setShowMoveDropdown(false)}
              />
            </div>
          )}
        </motion.div>
      )}
      <DeleteConfirmModal
        pending={deleteMode === null ? null : {
          // Skippable only when every ticked row is a server copy the delete
          // journals an undo for. One local-only row in the selection and the
          // same button destroys the only copy there is, which is the line
          // this preference does not cross — `allServerBacked` is the same
          // test the bar already uses to decide the action is offered at all.
          confirmOptional: deleteMode === "server" && allServerBacked,
          executor: confirmDelete,
          copy: {
            title: deleteMode === "unarchive"
              ? t("viewer.unarchiveEmail")
              : deleteMode === "everywhere"
              ? t("rowMenu.deleteEverywhere")
              : t("rowMenu.deleteServer"),
            description: deleteMode === "unarchive"
              ? selectedRows.some((email) =>
                  email.isArchived &&
                  (email.source === "local-only" ||
                    email._origin === "local-only")
                )
                ? t("viewer.emailOnlyExistsLocalArchive")
                : t("viewer.cachedCopyRemovedEmailStill")
              : deleteMode === "everywhere"
              ? t("selection.deleteServerVaultBackupDrive", { deleteScope })
              : t("selection.deleteServer2", {
                deleteScope,
                vaultClause: vaultClause(totalCount, archivedCount),
              }),
            confirmLabel: deleteMode === "unarchive"
              ? t("rowMenu.unarchive")
              : deleteMode === "everywhere"
              ? t("rowMenu.deleteEverywhere")
              : t("rowMenu.deleteServer"),
          },
        }}
        onClose={() => {
          setDeleteMode(null);
          requestAnimationFrame(() => confirmationReturnRef.current?.focus?.());
        }}
      />
    </AnimatePresence>
  );
}
