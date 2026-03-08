import { useMemo } from 'react';
import { getAccountCacheEmails } from '../stores/mailStore';

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
export function useSenderInsights(senderEmail) {
  return useMemo(() => {
    if (!senderEmail) return null;

    const target = senderEmail.toLowerCase().trim().replace(/^<|>$/g, '');
    const accountData = getAccountCacheEmails();

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
      accountsUsed: [...accountsUsed],
    };
  }, [senderEmail]);
}
