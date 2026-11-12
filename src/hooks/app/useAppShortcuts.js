import { useT } from '../../i18n/index.js';
import { currentListView } from '../../stores/viewStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useMailStore } from '../../stores/mailStore';
import { rowKey, spansMailboxes, stepThroughList, viewId } from '../../stores/slices/unifiedHelpers';
import { filterUnread } from '../../utils/emailParser';
import { useKeyboardShortcuts } from '../useKeyboardShortcuts';
import { openActiveReply } from '../../utils/composeOpener';
import { undoLastAction } from '../../services/workflows/messageMutations';
import { useInsightsStore } from '../../stores/insightsStore';
import * as selectionWorkflow from '../../services/workflows/selectEmail';
import { useNotesStore } from '../../stores/notesStore';
import { resolveContactsEscape, resolveEscapeAction } from '../../utils/escapeAction';
import { useUnsavedStore } from '../../stores/unsavedStore';
import { usePrivacyStore } from '../../stores/privacyStore';

// Undo too: the toast offers it over the board (a card's star, Done or
// delete), and Cmd+Z there did nothing.
const INSIGHTS_SHORTCUTS = ['compose', 'escape', 'openSettings', 'showShortcuts', 'undo'];

export function useAppShortcuts({ setComposeState, composeState, insightsOpen, notesOpen, contactsOpen, overlayOpen, showSettings, showShortcutsModal, setShowShortcutsModal, closeInsights, closeNotes, closeContacts, closeSettings, openSettings, setShowMoveDropdown, setSnoozeKeys }) {
  const t = useT();
  // j/k walk the list the user can actually see: with the unread filter on,
  // the store still holds every loaded message, so navigating the raw
  // sortedEmails would select rows that aren't on screen.
  //
  // Every comparison goes through rowKey. Comparing the open message's id to a
  // bare `e.uid` is what made this do nothing at all in the unified inbox.
  const step = (delta) => {
    if (currentListView() === 'explorer' && useSettingsStore.getState().viewStyle !== 'chat') {
      window.dispatchEvent(new CustomEvent('mailvault:explorer-step', { detail: delta }));
      return;
    }
    const state = useMailStore.getState();
    const { sortedEmails, selectedEmailId, selectedEmail, selectEmail, unreadOnly, unreadKeep } = state;
    const spans = spansMailboxes(state);
    const keyOf = (e) => rowKey(e, spans);
    const visible = filterUnread(sortedEmails, unreadOnly, selectedEmailId, keyOf, unreadKeep);
    // The open email places the step when the list no longer shows it. Not
    // matched by key: a body fetched from the server carries no _accountId.
    // With nothing open, the message a delete just closed the reader on keeps
    // the place, so the step does not start again from the top of the list.
    const anchor = state.readerAnchor?.view === viewId(state) ? state.readerAnchor.email : null;
    const open = selectedEmail || state.selectedThread?.lastEmail || anchor || null;
    const target = stepThroughList(visible, selectedEmailId, spans, delta, open);
    if (target) selectEmail(keyOf(target));
  };

  // Keyboard shortcuts — wire all shortcut actions to app state/store methods
  useKeyboardShortcuts({
    compose: () => setComposeState({}),
    reply: () => {
      if (!openActiveReply('reply')) {
        const email = useMailStore.getState().selectedEmail;
        if (email) setComposeState({ mode: 'reply', replyTo: email });
      }
    },
    replyAll: () => {
      if (!openActiveReply('replyAll')) {
        const email = useMailStore.getState().selectedEmail;
        if (email) setComposeState({ mode: 'replyAll', replyTo: email });
      }
    },
    forward: () => {
      // The reader first, like reply: it resolves a snippet stand-in's body
      // and shows the forward button busy meanwhile.
      if (!openActiveReply('forward')) {
        const email = useMailStore.getState().selectedEmail;
        if (email) setComposeState({ mode: 'forward', replyTo: email });
      }
    },
    // The open message's own row knows where it lives; the id alone does not
    // once the list spans mailboxes.
    archive: () => {
      const email = useMailStore.getState().selectedEmail;
      if (email) useMailStore.getState().saveEmailsLocally([email]);
    },
    delete: () => {
      const { selectedEmail, selectedEmailId } = useMailStore.getState();
      // deleteEmailFromServer resolves a composite key itself; in a list that
      // spans mailboxes selectedEmailId IS that key, and a key it cannot place
      // is refused rather than aimed at the active folder. Report the refusal —
      // unreported it reads as a keypress that did nothing. Same toast the
      // reading pane's delete uses.
      if (selectedEmail || selectedEmailId) {
        useMailStore.getState().deleteEmailFromServer(selectedEmailId)
          .catch(err => useMailStore.setState({ error: t('list.deleteFailed', { err: err?.message || err }) }));
      }
    },
    // selectedEmailId IS the selection key in every view (see selectEmail's
    // rowKey write), which is exactly what the toggle wants: a bare uid in a
    // single folder's list, the full key in one that spans mailboxes.
    toggleStar: () => {
      // On the key this actually spends: with only `selectedEmail` set, the
      // old test passed and `null` went to toggleFlagged, which resolves
      // nothing and warns.
      const { selectedEmailId } = useMailStore.getState();
      if (selectedEmailId) useMailStore.getState().toggleFlagged(selectedEmailId);
    },
    // One slot, not a stack: whatever the last mutation left there. The slot
    // outlives its toast, so this still works long after the toast has gone.
    // useKeyboardShortcuts ignores typing targets, so a text field's own Cmd+Z
    // never reaches here. Past the slot, the last delete comes back from the
    // deleted-mail bin. Never over an open compose: its Cmd+Z is the editor's.
    undo: () => { if (!composeState) undoLastAction(); },
    // j/k walk the list the user can actually see: with the unread filter on,
    // the store still holds every loaded message, so navigating the raw
    // sortedEmails would select rows that aren't on screen.
    nextEmail: () => step(+1),
    prevEmail: () => step(-1),
    goToInbox: () => { const s = useMailStore.getState(); s.activateAccount(s.activeAccountId, 'INBOX'); },
    goToSent: () => { const s = useMailStore.getState(); s.activateAccount(s.activeAccountId, 'Sent'); },
    goToDrafts: () => { const s = useMailStore.getState(); s.activateAccount(s.activeAccountId, 'Drafts'); },
    toggleSelect: () => {
      const email = useMailStore.getState().selectedEmail;
      if (email) {
        useMailStore.getState().toggleEmailSelection(email.uid, email._accountId, email._mailbox, email);
      }
    },
    escape: () => {
      if (insightsOpen && !composeState && !showSettings && !showShortcutsModal) {
        const insights = useInsightsStore.getState();
        if (insights.detailOpen) { selectionWorkflow.cancelInsightsSelection?.(); insights.setDetailOpen(false); }
        else if (insights.selection) insights.closeMessages();
        else closeInsights();
        return;
      }
      if (notesOpen && !composeState && !showSettings && !showShortcutsModal) {
        const notes = useNotesStore.getState();
        if (notes.detailOpen) { selectionWorkflow.cancelInsightsSelection?.(); notes.setDetailOpen(false); }
        else closeNotes();
        return;
      }
      if (contactsOpen && !composeState && !showSettings && !showShortcutsModal) {
        const el = document.activeElement;
        const what = resolveContactsEscape(el);
        if (what === 'blur') el.blur();
        else if (what === 'close') closeContacts();
        return;
      }
      const {
        selectedEmailIds, clearSelection, bulkModalOpen, bulkSession, endBulkSession,
      } = useMailStore.getState();
      const action = resolveEscapeAction({
        bulkModalOpen,
        bulkSessionActive: !!bulkSession?.active,
        selectedCount: selectedEmailIds.size,
        composeOpen: !!composeState,
        settingsOpen: showSettings,
        shortcutsOpen: showShortcutsModal,
      });
      if (action === 'end-bulk-session') endBulkSession();
      else if (action === 'clear-selection') clearSelection();
      else if (action === 'close-compose') setComposeState(null);
      else if (action === 'close-settings') useUnsavedStore.getState().leave(closeSettings);
      else if (action === 'close-shortcuts') setShowShortcutsModal(false);
    },
    focusSearch: () => {
      if ([...document.querySelectorAll('[role="dialog"]')].some(dialog =>
        !dialog.closest('[hidden], [inert], [aria-hidden="true"]'))) return;
      const input = document.querySelector('[data-testid="mail-search-input"]');
      if (input) input.focus();
      else document.querySelector('[data-testid="mail-search-toggle"]')?.click();
    },
    showShortcuts: () => setShowShortcutsModal(prev => !prev),
    openSettings,
    togglePrivacyMode: () => {
      const p = usePrivacyStore.getState();
      if (p.setEnabled(!p.enabled) === 'premium') openSettings({ tab: 'billing' });
    },
    moveToFolder: () => {
      const { selectedEmailIds, selectedEmailId } = useMailStore.getState();
      // Only open if there's something to move
      if (selectedEmailIds.size > 0 || selectedEmailId) {
        setShowMoveDropdown(true);
      }
    },
    // Gmail's key. The picker refuses nothing itself; snoozeEmails skips what
    // cannot be snoozed.
    snooze: () => {
      const { selectedEmailIds, selectedEmailId } = useMailStore.getState();
      const keys = selectedEmailIds.size > 0 ? [...selectedEmailIds] : selectedEmailId ? [selectedEmailId] : [];
      if (keys.length) setSnoozeKeys(keys);
    },
  }, { allowedActions: overlayOpen ? INSIGHTS_SHORTCUTS : null });
}
