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
  return subject
    .replace(/^(re:|fwd:|fw:|re\[\d+\]:)\s*/gi, '')
    .replace(/^(re:|fwd:|fw:|re\[\d+\]:)\s*/gi, '') // Run twice for nested
    .trim() || '(No subject)';
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
