import { Button } from "./ui/Button";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useSelectionStore } from "../stores/selectionStore";
import { useMessageListStore } from "../stores/messageListStore";
import { useSearchStore } from "../stores/searchStore";
import { X } from "lucide-react";
import { MoveToFolderDropdown } from "./MoveToFolderDropdown";
import { SnoozePicker } from "./SnoozePicker";
import { vaultClause, describeReaderDelete } from "../utils/custodyCopy";
import { useTagStore } from '../stores/tagStore';
import { useMailStore } from "../stores/mailStore";
import { useExportStore } from "../stores/exportStore";
import { QuickActions } from "./QuickActions";
import { useQuickActionConfiguration } from "../hooks/useQuickActionConfiguration";
import { useSettingsStore } from "../stores/settingsStore";
import {
  resolveEmailLocation,
  selectionKey,
} from "../stores/slices/unifiedHelpers";
import { savedMailboxes, selectionFacts } from "../utils/quickActionFacts";
import { describeQuickAction } from "../utils/quickActionCatalog";
import { DeleteConfirmModal } from "./DeleteConfirmModal";
import { isBackedUp, useBackupScan } from "./email/MessageStateIcon";
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
  const removeLocalEmails = useSelectionStore((s) => s.removeLocalEmails);
  const getSelectionSummary = useSelectionStore((s) => s.getSelectionSummary);
  const applyTagToRows = useTagStore((s) => s.applyTagToRows);
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
  const backupScan = useBackupScan();

  // Which delete was requested — 'server' or 'everywhere' — so a single
  // popover can show the right confirmation copy for whichever button
  // triggered it. null means the popover is closed.
  const [deleteMode, setDeleteMode] = useState(null);
  const [showMoveDropdown, setShowMoveDropdown] = useState(false);
  const [snoozeRect, setSnoozeRect] = useState(null);
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
    // Which verbs are inline is configuration: by default Move is a menu
    // entry, so `moveButtonRef` points into the popover that closes as this
    // runs, and measuring it anchored the dropdown to wherever that panel sat
    // — 188px left of the trigger on a 1200px window. Measure whatever the
    // user actually pressed inside the bar.
    const bar = barRef.current;
    const anchor = bar?.contains(moveButtonRef.current)
      ? moveButtonRef.current
      : bar?.querySelector(".quick-actions-trigger");
    const rect = anchor?.getBoundingClientRect();
    setMoveLeft(rect && bar ? rect.left - bar.getBoundingClientRect().left : 0);
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
    // One call: grouped per (account, mailbox) into one vault delete each.
    const targets = selectedRows
      .filter((email) => email.isArchived)
      .map((email) => ({ uid: email.uid, location: resolveEmailLocation(email, state) }))
      .filter((target) => target.location);
    try {
      if (targets.length) await removeLocalEmails(targets);
    } catch (e) {
      console.error("Failed to unarchive the selection:", e);
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
  // What the ticked messages are, as the bar's buttons and its confirmation
  // read them: the selection's keys, its rows the loaded lists (and search)
  // resolve, every loaded row, the open folder's archived uids, and whether
  // the backup drive holds any of them (the scan the rows already read).
  const facts = selectionFacts(
    selectedEmailIds,
    selectedRows,
    allSelectionRows,
    archivedEmailIds,
    useMailStore.getState(),
    { backedUp: selectedRows.some((email) => isBackedUp(email, backupScan) === true) },
  );
  const {
    archivedCount,
    totalCount,
    locations,
    localFolder,
    serverActions: allServerBacked,
    junkPath: selectionJunkPath,
  } = facts;
  const hasUnread = facts.has.markRead;
  const selectionKeys = [...selectedEmailIds];
  // What a button does. Which buttons are on offer is the view's.
  const runAction = async (entry, event) => {
    if (entry.action === "snooze") {
      setSnoozeRect(event.currentTarget.getBoundingClientRect());
    } else if (entry.action === "markRead") await handleAction(markSelectedAsRead);
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
      await applyTagToRows(
        selectedRows.map((email, index) => ({ email, location: locations[index] })),
        entry.params.tagId,
      );
    }
  };

  return (
    <AnimatePresence>
      {hasSelection && (
        <motion.div
          key="selection-bar"
          ref={barRef}
          data-testid="selection-action-bar"
          initial={{ y: 80, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 80, opacity: 0 }}
          transition={{ type: "spring", damping: 25, stiffness: 300 }}
          className="fixed inset-x-0 bottom-4 sm:bottom-6 z-40 flex justify-center px-3 pointer-events-none"
        >
          <SelectionActionBarView
            rows={selectedRows}
            keys={selectedEmailIds}
            config={config}
            label={selectionLabel}
            facts={facts}
            labelRef={selectionLabelRef}
            inlineAvailableWidth={inlineAvailableWidth}
            moveButtonRef={moveButtonRef}
            moveOpen={showMoveDropdown}
            onAction={runAction}
            onActionStart={(event, trigger, entry) => {
              if (
                ["delete", "deleteServer", "deleteEverywhere", "unarchive"]
                  .includes(entry.action)
              ) {
                confirmationReturnRef.current = trigger ||
                  event.currentTarget;
              }
            }}
            onClear={clearSelection}
          />

          {/* Move dropdown: a sibling of the scrolling bar, not a child of it */}
          {showMoveDropdown && (
            <div
              className="absolute bottom-full mb-2 pointer-events-auto"
              style={{ left: moveLeft }}
            >
              <MoveToFolderDropdown
                uids={[...selectedEmailIds]}
                accountId={facts.accountId ? locations[0]?.accountId : null}
                currentMailbox={facts.mailbox ? locations[0]?.mailbox : null}
                onClose={() => setShowMoveDropdown(false)}
              />
            </div>
          )}
          {snoozeRect && (
            <SnoozePicker
              keys={selectionKeys}
              anchorRect={{ left: snoozeRect.left, bottom: Math.max(8, snoozeRect.top - 300) }}
              onClose={() => setSnoozeRect(null)}
            />
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
          // A local folder's delete keeps a deleted-bin copy, so it may skip.
          confirmOptional: deleteMode === "server" && (allServerBacked || localFolder),
          executor: confirmDelete,
          copy: {
            title: deleteMode === "unarchive"
              ? t("viewer.unarchiveEmail")
              : deleteMode === "everywhere"
              ? t("rowMenu.deleteEverywhere")
              : localFolder
              ? t("common.delete")
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
              : localFolder
              ? describeReaderDelete({ localFolder })
              : t("selection.deleteServer2", {
                deleteScope,
                vaultClause: vaultClause(totalCount, archivedCount),
              }),
            confirmLabel: deleteMode === "unarchive"
              ? t("rowMenu.unarchive")
              : deleteMode === "everywhere"
              ? t("rowMenu.deleteEverywhere")
              : localFolder
              ? t("common.delete")
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

// The bar itself: the count, the configured actions and Clear, over the
// selected `rows`. SelectionActionBar floats it over the list and hands in the
// selection's `keys`, `facts` and what each button does (`onAction`).
// Settings' sample bar passes rows and `preview`: it sits in the page and
// every action is a no-op. Rows need `_accountId`, `_mailbox` and `source` for
// their actions to read as available.
export function SelectionActionBarView({
  rows: selectedRows,
  keys,
  config,
  label,
  facts,
  preview = false,
  onAction,
  onActionStart,
  onClear,
  labelRef,
  inlineAvailableWidth,
  moveButtonRef,
  moveOpen: showMoveDropdown = false,
}) {
  const t = useT();
  const localLabels = useTagStore((s) => s.tags) || EMPTY_ARRAY;
  const selectedEmailIds = keys || new Set(
    selectedRows.map((email) => selectionKey(email, useMailStore.getState())),
  );
  const state = useMailStore.getState();
  const targetFacts = facts || selectionFacts(
    selectedEmailIds,
    selectedRows,
    selectedRows,
    new Set(selectedRows.filter((email) => email.isArchived).map((email) => email.uid)),
    state,
  );
  const ctx = {
    tags: localLabels,
    templates: EMPTY_ARRAY,
    folders: (accountId) => savedMailboxes(state, accountId),
  };
  const selectionDescriptors = config.entries.map((entry) => ({
    ...describeQuickAction("selection", entry, targetFacts, ctx),
    buttonRef: entry.action === "move" ? moveButtonRef : undefined,
    expanded: entry.action === "move" ? showMoveDropdown : undefined,
    onActivate: preview ? () => {} : (event) => onAction(entry, event),
  }));

  return (
    <div
      className="flex items-center gap-1 px-2 py-1.5 bg-mail-surface border border-mail-strong
                         rounded-xl
                         max-w-[calc(100vw-1.5rem)] min-w-0 pointer-events-auto"
      data-quick-actions-preview={preview || undefined}
    >
      {/* Selection count */}
      <span
        ref={labelRef}
        data-selection-label
        className="text-sm font-medium text-mail-text px-3 whitespace-nowrap"
      >
        {label ?? t("selection.selected", { summary: selectedRows.length })}
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
        onActionStart={onActionStart}
        preview={preview}
      />

      <div className="w-px h-6 bg-mail-border" />

      {/* Clear */}
      <Button
        variant="ghost"
        icon
        size="md"
        onClick={onClear}
        title={t("selection.clearSelection")}
      >
        <X size={16} className="text-mail-text-muted" />
      </Button>
    </div>
  );
}
