/**
 * Email Parser Utilities for Chat View
 * Provides functions for grouping, parsing, and cleaning email content
 */

/**
 * Get the correspondent (the "other party") from an email
 * If email is from user, return the "to" address; otherwise return "from"
 */
export function getCorrespondent(email, userEmail) {
  const fromAddress = email.from?.address?.toLowerCase() || '';
  const userEmailLower = userEmail?.toLowerCase() || '';

  // Helper: clean up display name — strip quotes/escapes, if it's an email use local part
  const cleanName = (name, address) => {
    if (!name) return address || 'Unknown';
    // Strip paired surrounding quotes (e.g. "John Doe" → John Doe), then unescape inner quotes
    let cleaned = name;
    if (/^".*"$/.test(cleaned)) cleaned = cleaned.slice(1, -1);
    cleaned = cleaned.replace(/\\"/g, '"').trim();
    if (!cleaned) return address || 'Unknown';
    if (cleaned.includes('@')) return (address || cleaned).split('@')[0];
    return cleaned;
  };

  // If the email is from the user, the correspondent is the recipient
  if (fromAddress === userEmailLower) {
    const to = email.to?.[0];
    return {
      email: to?.address?.toLowerCase() || '',
      name: cleanName(to?.name, to?.address)
    };
  }

  // Otherwise, the correspondent is the sender
  return {
    email: fromAddress,
    name: cleanName(email.from?.name, email.from?.address)
  };
}

/**
 * Group emails by correspondent
 * Returns a Map of correspondent email -> conversation data
 */
export function groupByCorrespondent(emails, userEmail) {
  const groups = new Map();

  for (const email of emails) {
    const correspondent = getCorrespondent(email, userEmail);
    const key = correspondent.email;

    if (!key) continue;

    if (!groups.has(key)) {
      groups.set(key, {
        email: correspondent.email,
        name: correspondent.name,
        emails: [],
        unreadCount: 0,
        lastMessage: null
      });
    }

    const group = groups.get(key);
    group.emails.push(email);

    // Update name if we have a better one (prefer real display names over email-derived names)
    if (correspondent.name && !correspondent.name.includes('@')) {
      const currentIsWeak = group.name.includes('@') || !group.name.includes(' ');
      const newIsStrong = correspondent.name.includes(' ');
      if (currentIsWeak && newIsStrong) {
        group.name = correspondent.name;
      }
    }

    // Count unread
    if (!email.flags?.includes('\\Seen')) {
      group.unreadCount++;
    }

    // Track last message
    const emailDate = new Date(email.date || email.internalDate || 0);
    if (!group.lastMessage || emailDate > new Date(group.lastMessage.date)) {
      group.lastMessage = {
        subject: email.subject || '(No subject)',
        preview: getPreview(email),
        date: email.date || email.internalDate
      };
    }
  }

  // Sort emails within each group by date
  for (const group of groups.values()) {
    group.emails.sort((a, b) => {
      const dateA = new Date(a.date || a.internalDate || 0);
      const dateB = new Date(b.date || b.internalDate || 0);
      return dateA - dateB; // Oldest first for chat view
    });
  }

  return groups;
}

/**
 * Get a display-friendly sender name from an email.
 * If the display name is just the email address, returns the local part (before @) instead.
 */
export function getSenderName(email) {
  let rawName = email?.from?.name || '';
  let name = /^".*"$/.test(rawName) ? rawName.slice(1, -1) : rawName;
  name = name.replace(/\\"/g, '"').trim();
  const address = email?.from?.address || '';
  if (!name && !address) return 'Unknown';
  if (!name) return address;
  // If name looks like an email address (contains @), use the local part from the actual address instead
  if (name.includes('@')) return address.split('@')[0] || name;
  return name;
}

/**
 * Get a preview snippet from an email
 */
export function getPreview(email, maxLength = 50) {
  const text = email.text || email.textBody || email.snippet || '';
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= maxLength) return cleaned;
  return cleaned.substring(0, maxLength) + '...';
}

/**
 * Normalize subject for thread grouping
 * Strips Re:, Fwd:, FW:, RE: prefixes
 * Results are memoized to avoid redundant regex work across multiple code paths.
 */
const _normalizeSubjectCache = new Map();
export function normalizeSubject(subject) {
  if (!subject) return '(No subject)';
  const cached = _normalizeSubjectCache.get(subject);
  if (cached !== undefined) return cached;

  const prefix = /^(re:|fwd:|fw:|re\[\d+\]:)\s*/i;
  let result = subject.trim();
  let prev;
  do {
    prev = result;
    result = result.replace(prefix, '').trim();
  } while (result !== prev);
  const normalized = result || '(No subject)';

  // Cap cache size to avoid unbounded growth
  if (_normalizeSubjectCache.size > 50000) _normalizeSubjectCache.clear();
  _normalizeSubjectCache.set(subject, normalized);
  return normalized;
}

/**
 * Group emails by normalized subject within a conversation
 */
export function groupByTopic(emails) {
  const topics = new Map();

  for (const email of emails) {
    const normalizedSubject = normalizeSubject(email.subject);

    if (!topics.has(normalizedSubject)) {
      topics.set(normalizedSubject, {
        subject: normalizedSubject,
        originalSubject: email.subject || '(No subject)',
        emails: [],
        dateRange: { start: null, end: null }
      });
    }

    const topic = topics.get(normalizedSubject);
    topic.emails.push(email);

    // Update date range
    const emailDate = new Date(email.date || email.internalDate || 0);
    if (!topic.dateRange.start || emailDate < topic.dateRange.start) {
      topic.dateRange.start = emailDate;
    }
    if (!topic.dateRange.end || emailDate > topic.dateRange.end) {
      topic.dateRange.end = emailDate;
    }
  }

  // Sort emails within each topic by date (oldest first for chat)
  for (const topic of topics.values()) {
    topic.emails.sort((a, b) => {
      const dateA = new Date(a.date || a.internalDate || 0);
      const dateB = new Date(b.date || b.internalDate || 0);
      return dateA - dateB;
    });
  }

  return topics;
}

/**
 * Groups emails by sender address, then by normalized subject within each sender.
 * Returns an array of sender objects sorted by most recent email (descending).
 */
export function groupBySender(emails, userEmail) {
  if (!emails || emails.length === 0) return [];

  // When userEmail provided, use threading + correspondent-based grouping
  if (userEmail) {
    const threads = buildThreads(emails);
    const senderMap = new Map();

    for (const [, thread] of threads) {
      // Determine correspondent from the thread's emails
      // Use the first non-user email to find the external party
      let correspondent = null;
      for (const email of thread.emails) {
        const c = getCorrespondent(email, userEmail);
        if (c.email && c.email !== userEmail.toLowerCase()) {
          correspondent = c;
          break;
        }
      }
      if (!correspondent) {
        correspondent = getCorrespondent(thread.emails[0], userEmail);
      }

      const corrAddr = correspondent.email;
      if (!senderMap.has(corrAddr)) {
        senderMap.set(corrAddr, { senderEmail: corrAddr, senderName: correspondent.name, topics: [] });
      }
      const group = senderMap.get(corrAddr);
      if (correspondent.name && correspondent.name !== corrAddr.split('@')[0]) {
        group.senderName = correspondent.name;
      }

      // Build topic from thread — sort chronologically (oldest first) for conversation flow
      const topicEmails = [...thread.emails].sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0));
      const participants = new Set();
      let lastDate = null;
      let unreadCount = 0;

      for (const email of topicEmails) {
        const from = (email.from?.address || '').toLowerCase().trim();
        if (from) participants.add(from);
        if (email.to) {
          for (const r of email.to) {
            const addr = (r?.address || '').toLowerCase().trim();
            if (addr) participants.add(addr);
          }
        }
        const emailDate = email.date ? new Date(email.date) : null;
        if (emailDate && (!lastDate || emailDate > lastDate)) lastDate = emailDate;
        if (!email._fromSentFolder && !email.flags?.includes('\\Seen')) unreadCount++;
      }

      group.topics.push({
        subject: normalizeSubject(thread.subject),
        originalSubject: thread.subject || topicEmails[0]?.subject || '(No subject)',
        emails: topicEmails,
        participants: Array.from(participants),
        lastDate,
        unreadCount,
      });
    }

    // Build result with sorted topics and aggregated stats
    const result = [];
    for (const [senderEmail, group] of senderMap) {
      group.topics.sort((a, b) => (b.lastDate || 0) - (a.lastDate || 0));

      let senderUnread = 0;
      let senderLastDate = null;
      let totalEmails = 0;
      for (const topic of group.topics) {
        senderUnread += topic.unreadCount;
        totalEmails += topic.emails.length;
        if (topic.lastDate && (!senderLastDate || topic.lastDate > senderLastDate)) {
          senderLastDate = topic.lastDate;
        }
      }

      result.push({
        senderEmail,
        senderName: group.senderName,
        unreadCount: senderUnread,
        totalEmails,
        lastDate: senderLastDate,
        topics: group.topics,
      });
    }

    result.sort((a, b) => (b.lastDate || 0) - (a.lastDate || 0));
    return result;
  }

  // Fallback: original logic when no userEmail (backward compat)
  const senderMap = new Map();
  for (const email of emails) {
    const fromAddr = (email.from?.address || '').toLowerCase().trim();
    const fromName = email.from?.name || fromAddr.split('@')[0] || '';
    if (!senderMap.has(fromAddr)) {
      senderMap.set(fromAddr, { senderEmail: fromAddr, senderName: fromName, emails: [] });
    }
    senderMap.get(fromAddr).emails.push(email);
    if (fromName && fromName !== fromAddr.split('@')[0]) {
      senderMap.get(fromAddr).senderName = fromName;
    }
  }

  const result = [];
  for (const [senderEmail, senderData] of senderMap) {
    const topicMap = new Map();
    for (const email of senderData.emails) {
      const normSubj = normalizeSubject(email.subject);
      if (!topicMap.has(normSubj)) {
        topicMap.set(normSubj, {
          subject: normSubj,
          originalSubject: email.subject || '(No subject)',
          emails: [],
          participants: new Set(),
          lastDate: null,
          unreadCount: 0,
        });
      }
      const topic = topicMap.get(normSubj);
      topic.emails.push(email);

      const from = (email.from?.address || '').toLowerCase().trim();
      if (from) topic.participants.add(from);
      if (email.to) {
        for (const recipient of email.to) {
          const addr = (recipient?.address || '').toLowerCase().trim();
          if (addr) topic.participants.add(addr);
        }
      }

      const emailDate = email.date ? new Date(email.date) : null;
      if (emailDate && (!topic.lastDate || emailDate > topic.lastDate)) {
        topic.lastDate = emailDate;
      }

      if (!email.flags?.includes('\\Seen')) {
        topic.unreadCount++;
      }
    }

    const topics = [];
    for (const [, topic] of topicMap) {
      topic.emails.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
      topic.participants = Array.from(topic.participants);
      topics.push(topic);
    }

    topics.sort((a, b) => (b.lastDate || 0) - (a.lastDate || 0));

    let senderUnread = 0;
    let senderLastDate = null;
    for (const topic of topics) {
      senderUnread += topic.unreadCount;
      if (topic.lastDate && (!senderLastDate || topic.lastDate > senderLastDate)) {
        senderLastDate = topic.lastDate;
      }
    }

    result.push({
      senderEmail,
      senderName: senderData.senderName,
      unreadCount: senderUnread,
      lastDate: senderLastDate,
      topics,
    });
  }

  result.sort((a, b) => (b.lastDate || 0) - (a.lastDate || 0));
  return result;
}

/**
 * Build email threads using RFC 2822 header chains (References, In-Reply-To)
 * with normalized subject as fallback.
 *
 * Algorithm (simplified JWZ):
 * 1. Index all emails by Message-ID
 * 2. Link emails via References/In-Reply-To chains to find thread roots
 * 3. Fall back to normalized subject for emails without threading headers
 * 4. Return a Map of threadId → thread object
 *
 * @param {Array} emails - email objects with messageId, inReplyTo, references fields
 * @returns {Map<string, { threadId, subject, emails[], lastDate, participants, unreadCount }>}
 */
export function buildThreads(emails) {
  if (!emails || emails.length === 0) return new Map();

  // Step 1: Index by messageId
  const byMessageId = new Map(); // messageId → email
  for (const email of emails) {
    if (email.messageId) {
      byMessageId.set(email.messageId, email);
    }
  }

  // Step 2: Find the thread root for each email by walking the reference chain
  const emailToThreadId = new Map(); // email → threadId (root messageId)

  const rootCache = new Map(); // messageId → threadRoot (memoization to avoid O(N²) chain walks)

  const findRoot = (email, visited = new Set()) => {
    const id = email.messageId || (email.uid ? `uid-${email._accountId || ''}:${email.uid}` : null);
    if (id && rootCache.has(id)) return rootCache.get(id);
    if (id && visited.has(id)) return id;
    if (id) visited.add(id);

    let root;
    // Walk the references chain (oldest ancestor first)
    const refs = email.references || [];
    if (refs.length > 0) {
      // The first reference is the oldest ancestor = thread root
      root = refs[0];
    } else if (email.inReplyTo) {
      // Check if that parent has its own root
      const parent = byMessageId.get(email.inReplyTo);
      if (parent) {
        root = findRoot(parent, visited);
      } else {
        // Parent not in our set — use inReplyTo as the thread root
        root = email.inReplyTo;
      }
    } else {
      // No threading headers — this email is its own root
      root = email.messageId || `uid-${email._accountId || ''}:${email.uid}`;
    }

    if (id) rootCache.set(id, root);
    return root;
  };

  // Step 3: Assign thread IDs
  for (const email of emails) {
    const threadId = findRoot(email);
    emailToThreadId.set(email, threadId);
  }

  // Step 4: Group emails by thread ID
  const threadGroups = new Map(); // threadId → email[]
  for (const email of emails) {
    const threadId = emailToThreadId.get(email);
    if (!threadGroups.has(threadId)) {
      threadGroups.set(threadId, []);
    }
    threadGroups.get(threadId).push(email);
  }

  // Step 5: Subject-based fallback — merge single-email "threads" with matching subjects
  // Scoped per account so emails from different accounts never merge by subject alone
  const subjectToThreadId = new Map(); // "accountId\0subject" → threadId
  const threadIdToSubjectKey = new Map(); // threadId → "accountId\0subject"

  for (const [threadId, threadEmails] of threadGroups) {
    const subject = normalizeSubject(threadEmails[0].subject);
    const acct = threadEmails[0]._accountId || '';
    const key = `${acct}\0${subject}`;
    threadIdToSubjectKey.set(threadId, key);

    if (!subjectToThreadId.has(key)) {
      subjectToThreadId.set(key, threadId);
    }
  }

  // Merge threads with same normalized subject if they have no RFC threading headers
  // Two-pass: first add all non-orphan threads, then merge orphans into canonical threads
  const mergedGroups = new Map();
  const orphans = []; // [threadId, threadEmails][] — single-email threads without RFC headers

  for (const [threadId, threadEmails] of threadGroups) {
    const email = threadEmails[0];
    const hasRfcHeaders = email.inReplyTo || (email.references && email.references.length > 0);

    if (threadEmails.length === 1 && !hasRfcHeaders) {
      orphans.push([threadId, threadEmails]);
    } else {
      mergedGroups.set(threadId, [...threadEmails]);
    }
  }

  // Second pass: merge orphans into canonical threads by subject (within same account)
  for (const [threadId, threadEmails] of orphans) {
    const key = threadIdToSubjectKey.get(threadId);
    const canonicalThreadId = subjectToThreadId.get(key);

    if (canonicalThreadId !== threadId && mergedGroups.has(canonicalThreadId)) {
      mergedGroups.get(canonicalThreadId).push(...threadEmails);
    } else {
      // First orphan with this subject becomes the canonical target for future orphans
      mergedGroups.set(threadId, [...threadEmails]);
      subjectToThreadId.set(key, threadId);
    }
  }

  // Step 6: Build thread objects
  const threads = new Map();

  // Pre-parse dates once for all emails to avoid repeated new Date() in sort comparators
  const dateCache = new Map();
  const getDate = (email) => {
    let d = dateCache.get(email);
    if (d === undefined) {
      d = new Date(email.date || email.internalDate || 0).getTime();
      dateCache.set(email, d);
    }
    return d;
  };

  for (const [threadId, threadEmails] of mergedGroups) {
    // Sort by date ascending (oldest first)
    threadEmails.sort((a, b) => getDate(a) - getDate(b));

    const lastEmail = threadEmails[threadEmails.length - 1];
    const firstEmail = threadEmails[0];
    const lastDate = new Date(getDate(lastEmail));

    // Collect unique participants
    const participantSet = new Set();
    for (const e of threadEmails) {
      if (e.from?.address) participantSet.add(e.from.address.toLowerCase());
      if (e.to) {
        for (const to of e.to) {
          if (to.address) participantSet.add(to.address.toLowerCase());
        }
      }
    }

    // Count unread
    const unreadCount = threadEmails.filter(e => !e.flags?.includes('\\Seen')).length;

    const subject = normalizeSubject(firstEmail.subject);

    threads.set(threadId, {
      threadId,
      subject,
      originalSubject: firstEmail.subject || '(No subject)',
      emails: threadEmails,
      lastDate,
      lastEmail,
      participants: Array.from(participantSet),
      unreadCount,
      messageCount: threadEmails.length,
      dateRange: {
        start: new Date(getDate(firstEmail)),
        end: lastDate
      }
    });
  }

  return threads;
}

/**
 * Find the thread root for a single email given a messageId index.
 * Extracted from buildThreads() for reuse in incremental updates.
 */
function findThreadRoot(email, byMessageId, visited = new Set()) {
  if (email.messageId && visited.has(email.messageId)) return email.messageId;
  if (email.messageId) visited.add(email.messageId);

  const refs = email.references || [];
  if (refs.length > 0) return refs[0];

  if (email.inReplyTo) {
    const parent = byMessageId.get(email.inReplyTo);
    if (parent) return findThreadRoot(parent, byMessageId, visited);
    return email.inReplyTo;
  }

  return email.messageId || `uid-${email._accountId || ''}:${email.uid}`;
}

/**
 * Incrementally update an existing thread map with added/removed emails.
 * Only touches affected threads instead of rebuilding the entire map.
 *
 * @param {Map} existingThreads - previous buildThreads() result
 * @param {Array} newEmails - emails to add
 * @param {Set} removedUids - UIDs to remove
 * @param {Array} allEmails - full current email list (for messageId index)
 * @returns {Map} updated threads map (shallow copy with mutations)
 */
export function updateThreads(existingThreads, newEmails, removedUids, allEmails) {
  if (newEmails.length === 0 && removedUids.size === 0) return existingThreads;

  // Build messageId index from all emails for thread root lookups
  const byMessageId = new Map();
  for (const email of allEmails) {
    if (email.messageId) byMessageId.set(email.messageId, email);
  }

  // Shallow copy the threads map so React detects the change
  const threads = new Map(existingThreads);

  // Helper: pre-parse date for sorting
  const getTs = (email) => {
    if (email._threadTs !== undefined) return email._threadTs;
    email._threadTs = new Date(email.date || email.internalDate || 0).getTime();
    return email._threadTs;
  };

  // Helper: rebuild thread metadata after mutation
  const rebuildThreadMeta = (threadId, threadEmails) => {
    if (threadEmails.length === 0) {
      threads.delete(threadId);
      return;
    }
    threadEmails.sort((a, b) => getTs(a) - getTs(b));
    const firstEmail = threadEmails[0];
    const lastEmail = threadEmails[threadEmails.length - 1];
    const lastDate = new Date(getTs(lastEmail));

    const participantSet = new Set();
    for (const e of threadEmails) {
      if (e.from?.address) participantSet.add(e.from.address.toLowerCase());
      if (e.to) for (const to of e.to) if (to.address) participantSet.add(to.address.toLowerCase());
    }

    const unreadCount = threadEmails.filter(e => !e.flags?.includes('\\Seen')).length;

    threads.set(threadId, {
      threadId,
      subject: normalizeSubject(firstEmail.subject),
      originalSubject: firstEmail.subject || '(No subject)',
      emails: threadEmails,
      lastDate,
      lastEmail,
      participants: Array.from(participantSet),
      unreadCount,
      messageCount: threadEmails.length,
      dateRange: { start: new Date(getTs(firstEmail)), end: lastDate }
    });
  };

  // Remove emails by UID
  if (removedUids.size > 0) {
    for (const [threadId, thread] of existingThreads) {
      const filtered = thread.emails.filter(e => !removedUids.has(e.uid));
      if (filtered.length !== thread.emails.length) {
        rebuildThreadMeta(threadId, filtered);
      }
    }
  }

  // Add new emails
  if (newEmails.length > 0) {
    // Build subject-to-threadId index for orphan merging (scoped per account)
    const subjectToThreadId = new Map(); // "accountId\0subject" → threadId
    for (const [threadId, thread] of threads) {
      const subj = normalizeSubject(thread.emails[0]?.subject);
      const acct = thread.emails[0]?._accountId || '';
      const key = `${acct}\0${subj}`;
      if (!subjectToThreadId.has(key) || thread.emails.length > 1) {
        subjectToThreadId.set(key, threadId);
      }
    }

    for (const email of newEmails) {
      const threadId = findThreadRoot(email, byMessageId);
      const hasRfcHeaders = email.inReplyTo || (email.references && email.references.length > 0);

      // Try to find existing thread
      let targetThreadId = threadId;
      if (!threads.has(targetThreadId)) {
        // Orphan: try subject-based merge if no RFC headers (within same account)
        if (!hasRfcHeaders) {
          const subj = normalizeSubject(email.subject);
          const key = `${email._accountId || ''}\0${subj}`;
          const canonical = subjectToThreadId.get(key);
          if (canonical && threads.has(canonical)) {
            targetThreadId = canonical;
          }
        }
      }

      if (threads.has(targetThreadId)) {
        const existing = threads.get(targetThreadId);
        // Avoid duplicates (compound identity: account + uid)
        if (!existing.emails.some(e => e.uid === email.uid && (e._accountId || '') === (email._accountId || ''))) {
          const updatedEmails = [...existing.emails, email];
          rebuildThreadMeta(targetThreadId, updatedEmails);
        }
      } else {
        // New thread
        rebuildThreadMeta(threadId, [email]);
        // Register subject for future orphan merging
        const subj = normalizeSubject(email.subject);
        const key = `${email._accountId || ''}\0${subj}`;
        if (!subjectToThreadId.has(key)) {
          subjectToThreadId.set(key, threadId);
        }
      }
    }
  }

  return threads;
}

/**
 * Signature patterns to detect and strip
 */
const SIGNATURE_PATTERNS = [
  /^--\s*$/m,                               // RFC standard "--"
  /^_{3,}/m,                                // Underscore lines
  /^-{3,}/m,                                // Dash lines
  /^Sent from my (iPhone|iPad|Android|Galaxy|Pixel|Samsung)/im,
  /^Get Outlook for (iOS|Android|Mac|Windows)/im,
  /^Sent from Mail for Windows/im,
  /^Sent from Yahoo Mail/im,
  /^Sent from AOL Mobile Mail/im,
];

/**
 * Strip email signature from text body
 */
export function stripSignature(text) {
  if (!text) return '';

  let result = text;
  let minIndex = result.length;

  // Find the earliest signature delimiter
  for (const pattern of SIGNATURE_PATTERNS) {
    const match = result.match(pattern);
    if (match && match.index < minIndex) {
      minIndex = match.index;
    }
  }

  // Also check for common sign-offs followed by a name
  const signOffPatterns = [
    /^(Best|Kind|Warm)?\s*(Regards|Wishes),?\s*\n/im,
    /^Thanks?,?\s*\n/im,
    /^Cheers,?\s*\n/im,
    /^Sincerely,?\s*\n/im,
    /^Thank you,?\s*\n/im,
  ];

  for (const pattern of signOffPatterns) {
    const match = result.match(pattern);
    if (match && match.index < minIndex) {
      // Only use if it's in the last third of the message
      if (match.index > result.length * 0.5) {
        minIndex = match.index;
      }
    }
  }

  if (minIndex < result.length) {
    result = result.substring(0, minIndex).trim();
  }

  return result;
}

/**
 * Quote patterns to detect and strip
 */
const QUOTE_PATTERNS = [
  /^On .+wrote:\s*$/im,                      // "On [date] [person] wrote:"
  /^-{5,}Original Message-{5,}/im,          // Outlook style
  /^From:\s*.+\nSent:\s*.+\nTo:\s*.+/im,    // Email headers in body
  /^_{5,}\nFrom:\s*/im,                      // Underscore + From
];

/**
 * Strip quoted previous messages from text
 */
export function stripQuotedContent(text) {
  if (!text) return '';

  let result = text;

  // Find and remove quote blocks
  for (const pattern of QUOTE_PATTERNS) {
    const match = result.match(pattern);
    if (match) {
      result = result.substring(0, match.index).trim();
    }
  }

  // Remove lines starting with > (quoted text)
  const lines = result.split('\n');
  const filteredLines = [];
  let inQuoteBlock = false;

  for (const line of lines) {
    // Check if line is quoted
    if (line.trim().startsWith('>')) {
      inQuoteBlock = true;
      continue;
    }

    // If we were in a quote block and hit a non-quoted line, we're out
    if (inQuoteBlock && line.trim() && !line.trim().startsWith('>')) {
      // Check if this looks like continuation of quote context
      if (line.trim().match(/^(On|From|Sent|To|Subject|Date):/i)) {
        continue;
      }
      inQuoteBlock = false;
    }

    if (!inQuoteBlock) {
      filteredLines.push(line);
    }
  }

  return filteredLines.join('\n').trim();
}

/**
 * Get clean message body for chat display
 * Strips signatures and quoted content
 */
export function getCleanMessageBody(email) {
  let body = email.text || email.textBody || '';

  // If we only have HTML, try to extract text
  if (!body && email.html) {
    body = htmlToPlainText(email.html);
  }

  body = stripQuotedContent(body);
  body = stripSignature(body);

  return body.trim();
}

/**
 * Simple HTML to plain text conversion
 */
export function htmlToPlainText(html) {
  if (!html) return '';

  return html
    // Remove script and style tags with content
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    // Convert common elements to text equivalents
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<li>/gi, '- ')
    // Remove remaining HTML tags
    .replace(/<[^>]+>/g, '')
    // Decode common HTML entities
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    // Clean up whitespace
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Generate a consistent color from an email address
 */
export function getAvatarColor(email) {
  const colors = [
    '#6366f1', // indigo
    '#10b981', // emerald
    '#f59e0b', // amber
    '#ef4444', // red
    '#3b82f6', // blue
    '#8b5cf6', // violet
    '#ec4899', // pink
    '#14b8a6', // teal
    '#f97316', // orange
    '#06b6d4', // cyan
  ];

  if (!email) return colors[0];

  let hash = 0;
  for (let i = 0; i < email.length; i++) {
    hash = email.charCodeAt(i) + ((hash << 5) - hash);
  }

  return colors[Math.abs(hash) % colors.length];
}

/**
 * Get initials from name or email
 */
export function getInitials(name, email) {
  if (name && !name.includes('@')) {
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) {
      return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    }
    return name[0].toUpperCase();
  }

  if (email) {
    return email[0].toUpperCase();
  }

  return '?';
}

/**
 * Format relative time for chat display
 */
export function formatRelativeTime(dateStr) {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return date.toLocaleDateString(undefined, { weekday: 'short' });

  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// Lazy-loaded formatTime from dateFormat.js — avoids importing settingsStore
// at the module level (emailParser tests run in Node without a DOM).
let _cachedFormatTime = null;
let _formatTimeLoadAttempted = false;

/**
 * Format time for message bubble — respects the user's time format setting.
 */
export function formatMessageTime(dateStr) {
  // Try to load formatTime on first call (sync — the module will already be
  // in Vite's module graph if any component that renders times has loaded).
  if (!_formatTimeLoadAttempted) {
    _formatTimeLoadAttempted = true;
    try {
      // Kick off a dynamic import; it resolves asynchronously but we cache
      // the result for subsequent calls. First call uses the fallback.
      import('./dateFormat.js').then(mod => { _cachedFormatTime = mod.formatTime; }).catch(() => {});
    } catch { /* ignore */ }
  }

  if (_cachedFormatTime) return _cachedFormatTime(dateStr);

  // Fallback: locale default (used in tests or before async import resolves)
  const date = new Date(dateStr);
  return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/**
 * Format date separator for chat view
 */
export function formatDateSeparator(dateStr) {
  const date = new Date(dateStr);
  const now = new Date();
  const diffDays = Math.floor((now - date) / 86400000);

  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';

  return date.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined
  });
}

/**
 * Check if two dates are on different days
 */
export function isDifferentDay(date1Str, date2Str) {
  const date1 = new Date(date1Str);
  const date2 = new Date(date2Str);

  return date1.toDateString() !== date2.toDateString();
}

/**
 * Check if an email is from the user
 */
export function isFromUser(email, userEmail) {
  const fromAddress = email.from?.address?.toLowerCase() || '';
  return fromAddress === userEmail?.toLowerCase();
}
