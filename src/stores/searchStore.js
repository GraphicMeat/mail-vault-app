import { create } from 'zustand';
import * as db from '../services/db';
import * as api from '../services/api';
import { hasValidCredentials, ensureFreshToken } from '../services/authUtils';
import { useMailStore } from './mailStore';
import { useSettingsStore } from './settingsStore';
import { emailKey, flattenMailboxes } from './slices/unifiedHelpers';
import { mailboxDescendants, SUBTREE_PREFIX } from '../services/workflows/mailboxTree';

// The folders a server-side "all folders" search has to visit. \Noselect boxes
// are pure containers — SELECT fails on them — and a path can appear twice once
// the tree is flattened. INBOX goes first so the folder most searches want
// answers before the other 58 round trips.
export function serverSearchTargets(mailboxes) {
  const paths = [];
  const seen = new Set();
  for (const box of flattenMailboxes(mailboxes)) {
    if (box.noselect || !box.path || seen.has(box.path)) continue;
    seen.add(box.path);
    paths.push(box.path);
  }
  paths.sort((a, b) => (/^inbox$/i.test(a) ? -1 : 0) - (/^inbox$/i.test(b) ? -1 : 0));
  return paths;
}

/**
 * Which folders one search visits, and how much of the vault it may keep.
 *
 * One folder is too narrow to find a filed message and all 59 is too wide to
 * read; a branch is the scope the hierarchy exists to give you.
 */
export function searchScope(folder, { activeMailbox, mailboxes }) {
  const everyFolder = () => serverSearchTargets(mailboxes);
  let targets;
  let restrictTo = null;

  if (folder === 'all') {
    targets = everyFolder();
  } else if (folder === 'current') {
    // 'UNIFIED' is a view, not a mailbox: SELECTing it fails, and the view it
    // names is every folder anyway.
    targets = (activeMailbox && activeMailbox !== 'UNIFIED') ? [activeMailbox] : everyFolder();
  } else if (String(folder).startsWith(SUBTREE_PREFIX)) {
    const branch = new Set(mailboxDescendants(
      String(folder).slice(SUBTREE_PREFIX.length), flattenMailboxes(mailboxes)));
    // A branch root can be a container the server refuses to SELECT. Its
    // children are still perfectly searchable.
    targets = everyFolder().filter(p => branch.has(p));
    // Only a branch narrows the vault. "All folders" must not: a vault
    // directory for a mailbox the server no longer lists still holds readable
    // mail, and discarding it would be the same lie as searching INBOX alone.
    restrictTo = branch;
  } else {
    targets = [folder];
  }

  return { targets, localMailbox: targets.length === 1 ? targets[0] : null, restrictTo };
}

// Merge the three sources into the list the UI shows: one row per
// (account, mailbox, uid), newest first, preferring the copy that knows most
// about where it lives. Called once per finished folder during a fan-out, so
// it has to stay pure.
function finalize(allResults) {
  const seen = new Map();
  const sourcePriority = { 'local': 3, 'local-only': 3, 'server-search': 2, 'server': 1 };

  for (const email of allResults) {
    // A bare uid is not a key: folder A's uid 34 and folder B's uid 34 are
    // two different messages, and this loop kept exactly one of them —
    // by source priority, so the row on screen could already be a message
    // other than the one that matched.
    // `emailKey` always returns a string, so the messageId fallback has to
    // be chosen on the uid, not on a falsy key that never comes.
    const key = email.uid != null ? emailKey(email) : `mid:${email.messageId}`;
    const existing = seen.get(key);
    if (!existing || (sourcePriority[email.source] || 0) > (sourcePriority[existing.source] || 0)) {
      seen.set(key, email);
    }
  }

  return Array.from(seen.values()).sort((a, b) => {
    const dateA = new Date(a.date || a.internalDate || 0);
    const dateB = new Date(b.date || b.internalDate || 0);
    return dateB - dateA;
  });
}

// A fan-out across 59 folders outlives the query that started it: the user
// retypes, and the old loop is still writing rows for the old words. Every
// write past the first await is stamped with the run that made it.
let searchRun = 0;

export const useSearchStore = create((set, get) => ({
  searchActive: false,
  searchQuery: '',
  searchFilters: {
    location: 'all', // 'all' | 'server' | 'local'
    folder: 'current', // 'current' | 'all' | specific folder path
    sender: '',
    dateFrom: null,
    dateTo: null,
    hasAttachments: false,
  },
  searchResults: [],
  isSearching: false,
  // { done, total } while a multi-folder server search is in flight, else null.
  searchProgress: null,

  setSearchQuery: (query) => set({ searchQuery: query }),

  setSearchFilters: (filters) => set(state => ({
    searchFilters: { ...state.searchFilters, ...filters }
  })),

  performSearch: async () => {
    const runId = ++searchRun;
    const superseded = () => runId !== searchRun;
    const { searchQuery, searchFilters } = get();
    const { emails, localEmails, activeMailbox, activeAccountId, accounts, savedEmailIds, mailboxes } = useMailStore.getState();

    if (!searchQuery.trim() && !searchFilters.sender && !searchFilters.dateFrom && !searchFilters.dateTo) {
      set({ searchActive: false, searchResults: [], isSearching: false, searchProgress: null });
      return;
    }

    set({ isSearching: true, searchActive: true, searchProgress: null });

    let account = accounts.find(a => a.id === activeAccountId);
    account = await ensureFreshToken(account);
    const queryLower = searchQuery.toLowerCase().trim();

    // Helper to filter emails locally
    const filterEmailsLocally = (emailList, markSource) => {
      return emailList.filter(email => {
        const senderMatch = !queryLower ||
          email.from?.address?.toLowerCase().includes(queryLower) ||
          email.from?.name?.toLowerCase().includes(queryLower);
        const subjectMatch = !queryLower ||
          email.subject?.toLowerCase().includes(queryLower);
        const bodyMatch = !queryLower ||
          email.text?.toLowerCase().includes(queryLower) ||
          email.html?.toLowerCase().includes(queryLower) ||
          email.textBody?.toLowerCase().includes(queryLower) ||
          email.htmlBody?.toLowerCase().includes(queryLower);
        const senderFilterMatch = !searchFilters.sender ||
          email.from?.address?.toLowerCase().includes(searchFilters.sender.toLowerCase()) ||
          email.from?.name?.toLowerCase().includes(searchFilters.sender.toLowerCase());
        const emailDate = new Date(email.date || email.internalDate);
        const dateFromMatch = !searchFilters.dateFrom || emailDate >= new Date(searchFilters.dateFrom);
        const dateToMatch = !searchFilters.dateTo || emailDate <= new Date(searchFilters.dateTo);
        const attachmentMatch = !searchFilters.hasAttachments ||
          email.hasAttachments || (email.attachments && email.attachments.length > 0);
        const queryMatch = !queryLower || senderMatch || subjectMatch || bodyMatch;
        return queryMatch && senderFilterMatch && dateFromMatch && dateToMatch && attachmentMatch;
      }).map(e => ({
        ...e,
        // Stamp where this row came from at the one point that knows. Leaving
        // it off does not fail — `resolveEmailLocation` falls back to the
        // ACTIVE mailbox, so a hit from another folder is fetched from the
        // folder the sidebar happens to have selected and the server correctly
        // reports the uid missing. 'UNIFIED' is a view, not a mailbox.
        _accountId: e._accountId || e._srcAccountId || activeAccountId,
        _mailbox: e._mailbox || (activeMailbox && activeMailbox !== 'UNIFIED' ? activeMailbox : undefined),
        isLocal: markSource === 'local' || savedEmailIds.has(e.uid),
        source: markSource || e.source || 'server'
      }));
    };

    try {
      const allResults = [];
      const scope = searchScope(searchFilters.folder, { activeMailbox, mailboxes });

      // 1. Search in-memory emails (already loaded headers)
      // The loaded headers belong to the selected folder, so a branch search
      // run from somewhere else must not smuggle them in.
      const openFolderInScope = !scope.restrictTo || scope.restrictTo.has(activeMailbox);
      if (searchFilters.location !== 'local' && openFolderInScope) {
        const inMemoryResults = filterEmailsLocally(emails, 'server');
        allResults.push(...inMemoryResults);
        console.log(`[Search] Found ${inMemoryResults.length} in-memory matches`);
      }

      // 2. Search locally archived emails from Maildir
      if (searchFilters.location !== 'server') {
        try {
          const localResults = await db.searchLocalEmails(activeAccountId, searchQuery, {
            sender: searchFilters.sender,
            dateFrom: searchFilters.dateFrom,
            dateTo: searchFilters.dateTo,
            mailbox: scope.localMailbox,
            mailboxes,
            hasAttachments: searchFilters.hasAttachments
          });
          const kept = scope.restrictTo
            ? localResults.filter(r => scope.restrictTo.has(r._mailbox))
            : localResults;
          allResults.push(...kept);
          console.log(`[Search] Found ${kept.length} local Maildir matches`);
        } catch (error) {
          console.warn('[Search] Local search failed:', error);
        }
      }

      // 3. Search on server via IMAP (if online and not local-only search)
      if (searchFilters.location !== 'local' && account && hasValidCredentials(account)) {
        const serverFilters = {};
        if (searchFilters.sender) serverFilters.from = searchFilters.sender;
        if (searchFilters.dateFrom) serverFilters.since = searchFilters.dateFrom;
        if (searchFilters.dateTo) serverFilters.before = searchFilters.dateTo;

        // "All folders" has to mean the same thing on both halves of this
        // search. Step 2 walks every vault folder; this used to SELECT INBOX
        // and nothing else, so a user with 59 folders got INBOX's server hits
        // under a header that said "in all folders" — the one reading that
        // makes a message the vault never backed up look like it isn't there.
        // 'UNIFIED' is a view, not a mailbox: SELECTing it fails, and the view
        // it names is every folder anyway.
        const targets = scope.targets;

        for (const [i, mailboxToSearch] of targets.entries()) {
          if (superseded()) return;
          if (targets.length > 1) set({ searchProgress: { done: i, total: targets.length } });

          try {
            const serverResponse = await api.searchEmails(account, mailboxToSearch, searchQuery, serverFilters);

            if (serverResponse.emails && serverResponse.emails.length > 0) {
              const serverResults = serverResponse.emails.map(e => ({
                ...e,
                _accountId: activeAccountId,
                _mailbox: mailboxToSearch,
                isLocal: savedEmailIds.has(e.uid),
                source: 'server-search'
              }));
              allResults.push(...serverResults);
              console.log(`[Search] Found ${serverResults.length} server matches in ${mailboxToSearch} (total on server: ${serverResponse.total})`);
            }
          } catch (error) {
            // 58 readable folders must not be lost to one that isn't.
            console.warn(`[Search] Server search failed in ${mailboxToSearch}:`, error);
          }

          // Publish as we go: a 59-folder sweep is long enough that a list
          // which only fills at the end reads as a search that found nothing.
          if (targets.length > 1) {
            if (superseded()) return;
            set({ searchResults: finalize(allResults), searchProgress: { done: i + 1, total: targets.length } });
          }
        }
      }

      const deduplicatedResults = finalize(allResults);

      if (superseded()) return;
      console.log(`[Search] Total unique results: ${deduplicatedResults.length}`);
      set({ searchResults: deduplicatedResults, isSearching: false, searchProgress: null });

      if (searchQuery.trim()) {
        useSettingsStore.getState().addSearchToHistory(searchQuery.trim());
      }
    } catch (error) {
      console.error('[searchStore] Search failed:', error);
      if (superseded()) return;
      set({ isSearching: false, searchResults: [], searchProgress: null });
    }
  },

  clearSearch: () => set({
    searchActive: false,
    searchQuery: '',
    searchFilters: {
      location: 'all',
      folder: 'current',
      sender: '',
      dateFrom: null,
      dateTo: null,
      hasAttachments: false,
    },
    searchResults: [],
    isSearching: false,
    searchProgress: null
  })
}));
