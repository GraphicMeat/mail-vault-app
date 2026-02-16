/**
 * Computes the display email list with correct `source` flags.
 *
 * @param {Object} params
 * @param {boolean}  params.searchActive
 * @param {Array}    params.searchResults
 * @param {Array}    params.emails        – server emails currently loaded
 * @param {Array}    params.localEmails    – locally archived emails
 * @param {Set}      params.archivedEmailIds
 * @param {string}   params.viewMode      – 'local' | 'server' | 'all'
 * @returns {Array}  emails with `isArchived` and `source` fields
 */
export function computeDisplayEmails({
  searchActive,
  searchResults,
  emails,
  localEmails,
  archivedEmailIds,
  viewMode,
}) {
  if (searchActive) return searchResults;

  if (viewMode === 'local') {
    const serverUids = new Set(emails.map((e) => e.uid));
    // Only show explicitly archived emails in local view
    const archivedLocal = localEmails.filter((e) => archivedEmailIds.has(e.uid));
    return archivedLocal.map((e) => ({
      ...e,
      isArchived: true,
      source: serverUids.size > 0 && !serverUids.has(e.uid) ? 'local-only' : 'local',
    }));
  }

  if (viewMode === 'server') {
    return emails.map((e) => ({
      ...e,
      isArchived: archivedEmailIds.has(e.uid),
      source: 'server',
    }));
  }

  // viewMode === 'all': Combine server emails + local-only emails
  const serverUids = new Set(emails.map((e) => e.uid));
  const combinedEmails = emails.map((e) => ({
    ...e,
    isArchived: archivedEmailIds.has(e.uid),
    source: 'server',
  }));

  for (const localEmail of localEmails) {
    if (!serverUids.has(localEmail.uid) && archivedEmailIds.has(localEmail.uid)) {
      combinedEmails.push({
        ...localEmail,
        isArchived: true,
        source: 'local-only',
      });
    }
  }

  combinedEmails.sort((a, b) => {
    const dateA = new Date(a.date || a.internalDate || 0);
    const dateB = new Date(b.date || b.internalDate || 0);
    return dateB - dateA;
  });

  return combinedEmails;
}
