import { useInsightsStore } from '../../stores/insightsStore';
import { useNotesStore } from '../../stores/notesStore';
import { useContactsViewStore } from '../../stores/contactsViewStore';
import { useCallback, useEffect, useRef } from 'react';
import { createInsightsReaderScope } from '../../services/insightsReaderScope';
import { useMailStore } from '../../stores/mailStore';
import * as selectionWorkflow from '../../services/workflows/selectEmail';

// Leaving Insights or Notes for the mail the user picked: never bring the
// earlier selection back over it.
const KEEP_NO_SELECTION = { restoreSelection: false };

export function useOverlayPages() {
  const insightsOpen = useInsightsStore(s => s.isOpen);
  const notesOpen = useNotesStore(s => s.isOpen);
  const contactsOpen = useContactsViewStore(s => s.isOpen);
  // Insights, Notes to Self and Contacts are full pages over the mail view, one
  // at a time; they share the reader scope that puts the open message back.
  const overlayOpen = insightsOpen || notesOpen || contactsOpen;
  const insightsReaderScope = useRef(null);
  if (!insightsReaderScope.current) insightsReaderScope.current = createInsightsReaderScope(useMailStore, {
    cancelSelection: () => selectionWorkflow.cancelInsightsSelection?.(),
    getSelectionGeneration: () => selectionWorkflow.getSelectionGeneration(),
  });
  const openInsights = useCallback(() => {
    if (useInsightsStore.getState().isOpen) return;
    insightsReaderScope.current.enter();
    if (useNotesStore.getState().isOpen) { selectionWorkflow.cancelInsightsSelection?.(); useNotesStore.getState().close(); }
    if (useContactsViewStore.getState().isOpen) useContactsViewStore.getState().close();
    void useInsightsStore.getState().openInsights();
  }, []);
  const closeInsights = useCallback(() => {
    useInsightsStore.getState().closeInsights();
    void insightsReaderScope.current.exit();
    requestAnimationFrame(() => document.querySelector('[data-testid="open-insights"]')?.focus());
  }, []);
  const openNotes = useCallback(() => {
    if (useNotesStore.getState().isOpen) return;
    insightsReaderScope.current.enter();
    if (useInsightsStore.getState().isOpen) useInsightsStore.getState().closeInsights();
    if (useContactsViewStore.getState().isOpen) useContactsViewStore.getState().close();
    void useNotesStore.getState().open();
  }, []);
  const closeNotes = useCallback(() => {
    selectionWorkflow.cancelInsightsSelection?.();
    useNotesStore.getState().close();
    void insightsReaderScope.current.exit();
    requestAnimationFrame(() => document.querySelector('[data-testid="open-notes"]')?.focus());
  }, []);
  const openContacts = useCallback(() => {
    if (useContactsViewStore.getState().isOpen) return;
    insightsReaderScope.current.enter();
    if (useInsightsStore.getState().isOpen) useInsightsStore.getState().closeInsights();
    if (useNotesStore.getState().isOpen) { selectionWorkflow.cancelInsightsSelection?.(); useNotesStore.getState().close(); }
    useContactsViewStore.getState().open();
  }, []);
  const closeContacts = useCallback(() => {
    selectionWorkflow.cancelInsightsSelection?.();
    useContactsViewStore.getState().close();
    void insightsReaderScope.current.exit();
    requestAnimationFrame(() => document.querySelector('[data-testid="open-contacts"]')?.focus());
  }, []);
  const openMailFromSidebar = useCallback(() => {
    insightsReaderScope.current.cancelRestore();
    const insights = useInsightsStore.getState().isOpen, notes = useNotesStore.getState().isOpen;
    const contacts = useContactsViewStore.getState().isOpen;
    if (!insights && !notes && !contacts) return;
    if (insights) useInsightsStore.getState().closeInsights();
    if (notes) { selectionWorkflow.cancelInsightsSelection?.(); useNotesStore.getState().close(); }
    if (contacts) { selectionWorkflow.cancelInsightsSelection?.(); useContactsViewStore.getState().close(); }
    void insightsReaderScope.current.exit(KEEP_NO_SELECTION);
  }, []);
  useEffect(() => () => { useInsightsStore.getState().resetSession(); useNotesStore.getState().close(); useContactsViewStore.getState().close(); }, []);

  return { insightsOpen, notesOpen, contactsOpen, overlayOpen, openInsights, closeInsights, openNotes, closeNotes, openContacts, closeContacts, openMailFromSidebar };
}
