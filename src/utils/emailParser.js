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

  // If the email is from the user, the correspondent is the recipient
  if (fromAddress === userEmailLower) {
    const to = email.to?.[0];
    return {
      email: to?.address?.toLowerCase() || '',
      name: to?.name || to?.address || 'Unknown'
    };
  }

  // Otherwise, the correspondent is the sender
  return {
    email: fromAddress,
    name: email.from?.name || email.from?.address || 'Unknown'
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

    // Update name if we have a better one (non-email name)
    if (correspondent.name && !correspondent.name.includes('@') && group.name.includes('@')) {
      group.name = correspondent.name;
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
 */
export function normalizeSubject(subject) {
  if (!subject) return '(No subject)';
  const prefix = /^(re:|fwd:|fw:|re\[\d+\]:)\s*/i;
  let result = subject.trim();
  let prev;
  do {
    prev = result;
    result = result.replace(prefix, '').trim();
  } while (result !== prev);
  return result || '(No subject)';
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

  const findRoot = (email, visited = new Set()) => {
    if (email.messageId && visited.has(email.messageId)) return email.messageId;
    if (email.messageId) visited.add(email.messageId);

    // Walk the references chain (oldest ancestor first)
    const refs = email.references || [];
    if (refs.length > 0) {
      // The first reference is the oldest ancestor = thread root
      return refs[0];
    }
    // Fall back to inReplyTo
    if (email.inReplyTo) {
      // Check if that parent has its own root
      const parent = byMessageId.get(email.inReplyTo);
      if (parent) {
        return findRoot(parent, visited);
      }
      // Parent not in our set — use inReplyTo as the thread root
      return email.inReplyTo;
    }
    // No threading headers — this email is its own root
    return email.messageId || `uid-${email.uid}`;
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
  const subjectToThreadId = new Map(); // normalizedSubject → threadId (of first multi-email thread or first occurrence)
  const threadIdToSubject = new Map(); // threadId → normalizedSubject

  for (const [threadId, threadEmails] of threadGroups) {
    const subject = normalizeSubject(threadEmails[0].subject);
    threadIdToSubject.set(threadId, subject);

    if (!subjectToThreadId.has(subject)) {
      subjectToThreadId.set(subject, threadId);
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

  // Second pass: merge orphans into canonical threads by subject
  for (const [threadId, threadEmails] of orphans) {
    const subject = threadIdToSubject.get(threadId);
    const canonicalThreadId = subjectToThreadId.get(subject);

    if (canonicalThreadId !== threadId && mergedGroups.has(canonicalThreadId)) {
      mergedGroups.get(canonicalThreadId).push(...threadEmails);
    } else {
      mergedGroups.set(threadId, [...threadEmails]);
    }
  }

  // Step 6: Build thread objects
  const threads = new Map();

  for (const [threadId, threadEmails] of mergedGroups) {
    // Sort by date ascending (oldest first)
    threadEmails.sort((a, b) => {
      const dateA = new Date(a.date || a.internalDate || 0);
      const dateB = new Date(b.date || b.internalDate || 0);
      return dateA - dateB;
    });

    const lastEmail = threadEmails[threadEmails.length - 1];
    const firstEmail = threadEmails[0];
    const lastDate = new Date(lastEmail.date || lastEmail.internalDate || 0);

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
        start: new Date(firstEmail.date || firstEmail.internalDate || 0),
        end: lastDate
      }
    });
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
  if (diffDays < 7) return date.toLocaleDateString('en-US', { weekday: 'short' });

  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * Format time for message bubble
 */
export function formatMessageTime(dateStr) {
  const date = new Date(dateStr);
  return date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });
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

  return date.toLocaleDateString('en-US', {
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
