import { useMemo } from 'react';
import { getAccountCacheEmails } from '../stores/mailStore';
import { useSearchStore } from '../stores/searchStore';
import { emailKey } from '../stores/slices/unifiedHelpers';

/**
 * Extract a normalized email address from various "from"/"to" field formats.
 * Handles: { address: "foo@bar.com" }, "Name <foo@bar.com>", "foo@bar.com"
 */
function normalizeEmail(raw) {
  if (!raw) return '';
  if (typeof raw === 'object' && raw.address) return raw.address.toLowerCase().trim();
  const str = String(raw).trim().toLowerCase();
  const match = str.match(/<([^>]+)>/);
  return match ? match[1].trim() : str;
}

/**
 * Format a frequency string from total count and date range in months.
 */
function formatFrequency(total, firstDate, lastDate) {
  if (!firstDate || !lastDate || total <= 1) return '<1/month';
  const months = Math.max(1, (lastDate - firstDate) / (1000 * 60 * 60 * 24 * 30.44));
  const perMonth = total / months;
  if (perMonth < 1) return '<1/month';
  return `~${Math.round(perMonth)}/month`;
}

/**
 * Computes sender analytics from locally cached email data across all accounts.
 *
 * @param {string} senderEmail - The email address to analyze
 * @returns {Object|null} Sender insights or null if no data
 */
export function useSenderInsights(senderEmail, openEmail = null) {
  return useMemo(() => {
    if (!senderEmail) return null;

    const target = senderEmail.toLowerCase().trim().replace(/^<|>$/g, '');
    // The open folder's list, plus the search results a hit was opened from
    // (a hit from another folder is in no list the mail store holds), plus the
    // open message itself: the panel counts at least what is on screen.
    const { searchActive, searchResults } = useSearchStore.getState();
    const seen = new Set();
    const once = email => { const key = emailKey(email); if (seen.has(key)) return false; seen.add(key); return true; };
    const accountData = getAccountCacheEmails().map(account => ({ ...account, emails: account.emails.filter(once) }));
    const extra = [...(searchActive ? searchResults : []), ...(openEmail ? [openEmail] : [])].filter(once);
    if (extra.length) accountData.push({ accountEmail: openEmail?._accountId || accountData[0]?.accountEmail, emails: extra, sentEmails: [] });

    let totalReceived = 0;
    let totalSent = 0;
    let firstDate = null;
    let lastDate = null;
    const subjectCounts = new Map();
    const accountsUsed = new Set();

    for (const { accountEmail, emails, sentEmails } of accountData) {
      // Scan received emails — match by sender
      for (const email of emails) {
        const fromAddr = normalizeEmail(email.from);
        if (fromAddr !== target) continue;

        totalReceived++;
        accountsUsed.add(accountEmail);

        const d = new Date(email.date || email.internalDate || 0);
        if (!isNaN(d.getTime())) {
          if (!firstDate || d < firstDate) firstDate = d;
          if (!lastDate || d > lastDate) lastDate = d;
        }

        const subj = (email.subject || '').trim();
        if (subj) subjectCounts.set(subj, (subjectCounts.get(subj) || 0) + 1);
      }

      // Scan sent emails — match by recipient
      for (const email of sentEmails) {
        const recipients = Array.isArray(email.to) ? email.to : [];
        const match = recipients.some(r => normalizeEmail(r) === target);
        if (!match) continue;

        totalSent++;
        accountsUsed.add(accountEmail);

        const d = new Date(email.date || email.internalDate || 0);
        if (!isNaN(d.getTime())) {
          if (!firstDate || d < firstDate) firstDate = d;
          if (!lastDate || d > lastDate) lastDate = d;
        }

        const subj = (email.subject || '').trim();
        if (subj) subjectCounts.set(subj, (subjectCounts.get(subj) || 0) + 1);
      }
    }

    const total = totalReceived + totalSent;
    if (total === 0) return null;

    // Top 3 subjects by frequency
    const topSubjects = [...subjectCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([subj]) => subj);

    return {
      totalReceived,
      totalSent,
      total,
      firstDate,
      lastDate,
      frequency: formatFrequency(total, firstDate, lastDate),
      topSubjects,
      accountsUsed: [...accountsUsed].filter(Boolean),
    };
  }, [senderEmail, openEmail]);
}
