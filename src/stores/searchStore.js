import { create } from 'zustand';
import * as db from '../services/db';
import * as api from '../services/api';
import { hasValidCredentials, ensureFreshToken } from '../services/authUtils';
import { useMailStore } from './mailStore';
import { useSettingsStore } from './settingsStore';

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

  setSearchQuery: (query) => set({ searchQuery: query }),

  setSearchFilters: (filters) => set(state => ({
    searchFilters: { ...state.searchFilters, ...filters }
  })),

  performSearch: async () => {
    const { searchQuery, searchFilters } = get();
    const { emails, localEmails, activeMailbox, activeAccountId, accounts, savedEmailIds } = useMailStore.getState();

    if (!searchQuery.trim() && !searchFilters.sender && !searchFilters.dateFrom && !searchFilters.dateTo) {
      set({ searchActive: false, searchResults: [], isSearching: false });
      return;
    }

    set({ isSearching: true, searchActive: true });

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
        isLocal: markSource === 'local' || savedEmailIds.has(e.uid),
        source: markSource || e.source || 'server'
      }));
    };

    try {
      const allResults = [];

      // 1. Search in-memory emails (already loaded headers)
      if (searchFilters.location !== 'local') {
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
            mailbox: searchFilters.folder === 'current' ? activeMailbox :
                     searchFilters.folder === 'all' ? null : searchFilters.folder,
            hasAttachments: searchFilters.hasAttachments
          });
          allResults.push(...localResults);
          console.log(`[Search] Found ${localResults.length} local Maildir matches`);
        } catch (error) {
          console.warn('[Search] Local search failed:', error);
        }
      }

      // 3. Search on server via IMAP (if online and not local-only search)
      if (searchFilters.location !== 'local' && account && hasValidCredentials(account)) {
        try {
          const serverFilters = {};
          if (searchFilters.sender) serverFilters.from = searchFilters.sender;
          if (searchFilters.dateFrom) serverFilters.since = searchFilters.dateFrom;
          if (searchFilters.dateTo) serverFilters.before = searchFilters.dateTo;

          const mailboxToSearch = searchFilters.folder === 'current' ? activeMailbox :
                                  searchFilters.folder === 'all' ? 'INBOX' : searchFilters.folder;

          const serverResponse = await api.searchEmails(account, mailboxToSearch, searchQuery, serverFilters);

          if (serverResponse.emails && serverResponse.emails.length > 0) {
            const serverResults = serverResponse.emails.map(e => ({
              ...e,
              isLocal: savedEmailIds.has(e.uid),
              source: 'server-search'
            }));
            allResults.push(...serverResults);
            console.log(`[Search] Found ${serverResults.length} server matches (total on server: ${serverResponse.total})`);
          }
        } catch (error) {
          console.warn('[Search] Server search failed:', error);
        }
      }

      // 4. Deduplicate results by UID (prefer local > server-search > server)
      const seen = new Map();
      const sourcePriority = { 'local': 3, 'local-only': 3, 'server-search': 2, 'server': 1 };

      for (const email of allResults) {
        const key = email.uid || email.messageId;
        const existing = seen.get(key);
        if (!existing || (sourcePriority[email.source] || 0) > (sourcePriority[existing.source] || 0)) {
          seen.set(key, email);
        }
      }

      const deduplicatedResults = Array.from(seen.values());

      // 5. Sort by date (newest first)
      deduplicatedResults.sort((a, b) => {
        const dateA = new Date(a.date || a.internalDate || 0);
        const dateB = new Date(b.date || b.internalDate || 0);
        return dateB - dateA;
      });

      console.log(`[Search] Total unique results: ${deduplicatedResults.length}`);
      set({ searchResults: deduplicatedResults, isSearching: false });

      if (searchQuery.trim()) {
        useSettingsStore.getState().addSearchToHistory(searchQuery.trim());
      }
    } catch (error) {
      console.error('[searchStore] Search failed:', error);
      set({ isSearching: false, searchResults: [] });
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
    isSearching: false
  })
}));
