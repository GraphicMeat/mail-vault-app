/**
 * Pure function for computing display emails from store state.
 * Used by tests; the store's updateSortedEmails() has equivalent inline logic
 * with additional memoization and serverUidSet from IMAP.
 *
 * @param {Object} state
 * @param {boolean} state.searchActive
 * @param {Array} state.searchResults
 * @param {Array} state.emails - Server/cached emails
 * @param {Array} state.localEmails - Locally archived emails
 * @param {Set} state.archivedEmailIds
 * @param {string} state.viewMode - 'all' | 'server' | 'local'
 * @param {Set} [state.serverUidSet] - Full server UID set (optional; derived from emails if absent)
 * @returns {Array} Display-ready emails with source/isArchived/isLocal flags
 */
export function computeDisplayEmails({ searchActive, searchResults, emails, localEmails, archivedEmailIds, viewMode, serverUidSet }) {
  if (searchActive) return searchResults;

  // If no explicit serverUidSet, derive from emails array (backward compat for tests)
  const serverUids = serverUidSet || new Set(emails.map(e => e.uid));

  let result = [];

  if (viewMode === 'server') {
    result = emails.map(e => ({
      ...e,
      isLocal: false,
      isArchived: archivedEmailIds.has(e.uid),
      source: 'server'
    }));
  } else if (viewMode === 'local') {
    result = localEmails
      .filter(e => archivedEmailIds.has(e.uid))
      .map(e => ({
        ...e,
        isLocal: true,
        isArchived: true,
        source: serverUids.size > 0 && !serverUids.has(e.uid) ? 'local-only' : 'local'
      }));
  } else {
    // viewMode === 'all'
    const loadedUids = new Set(emails.map(e => e.uid));
    const combinedEmails = emails.map(e => ({
      ...e,
      isLocal: false,
      isArchived: archivedEmailIds.has(e.uid),
      source: 'server'
    }));

    for (const localEmail of localEmails) {
      if (!loadedUids.has(localEmail.uid) && archivedEmailIds.has(localEmail.uid)) {
        combinedEmails.push({
          ...localEmail,
          isLocal: true,
          isArchived: true,
          source: serverUids.size > 0 && !serverUids.has(localEmail.uid) ? 'local-only' : 'local'
        });
      }
    }

    result = combinedEmails;
  }

  // Sort by date descending (newest first)
  result.sort((a, b) => new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime());

  return result;
}
