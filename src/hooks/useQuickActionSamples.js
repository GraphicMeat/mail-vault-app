import { useEffect, useMemo, useState } from 'react';
import { useMailStore } from '../stores/mailStore';
import { useSettingsStore } from '../stores/settingsStore';
import { emailScopeKey } from '../stores/slices/unifiedHelpers';
import { getEmailHeadersPartial } from '../services/db';
import { previewRows } from '../data/previewMail';

const COUNT = 5;
const EMPTY = Object.freeze([]);

// The account the samples came from and its rows as last read: every open of
// Settings or onboarding shows the same mailbox, drawn at once, then re-read.
let last = null;
export function _resetQuickActionSamples() { last = null; }

// previewMail's cast as message rows, for someone with no mail on this
// computer yet (onboarding's first run, an empty vault). Negative uids: no
// message anywhere has one.
function castRows(accountId) {
  return previewRows().slice(0, COUNT).map((row, index) => ({
    uid: -1 - index,
    subject: row.subject,
    snippet: row.snippet,
    from: { name: row.sender, address: '' },
    to: [],
    date: row.at.toISOString(),
    flags: row.unread ? [] : ['\\Seen'],
    _accountId: accountId,
    _mailbox: 'INBOX',
    source: 'server',
  }));
}

/**
 * The latest few messages of one of the person's inboxes, for the quick
 * actions previews (Settings, its detached window, onboarding) to draw with
 * the real list row, selection bar and reader toolbar.
 *
 * Read from this computer's header cache only: no server, no sign-in, nothing
 * in Network Activity. The account is picked at random once and kept; one with
 * nothing cached is passed over for the next, and with none at all the rows
 * are previewMail's cast. A star or read change made since the cache was
 * written shows through from the list's own rows.
 */
export function useQuickActionSamples() {
  const accounts = useMailStore(state => state.accounts) || EMPTY;
  const hidden = useSettingsStore(state => state.hiddenAccounts);
  const emails = useMailStore(state => state.emails);
  const ids = accounts.map(account => account.id).filter(id => !hidden?.[id]);
  const idsKey = ids.join('|');
  const [rows, setRows] = useState(() => last?.rows || castRows('sample'));

  useEffect(() => {
    let live = true;
    const start = Math.floor(Math.random() * ids.length);
    const order = ids.includes(last?.accountId)
      ? [last.accountId, ...ids.filter(id => id !== last.accountId)]
      : [...ids.slice(start), ...ids.slice(0, start)];
    (async () => {
      for (const accountId of order) {
        const cached = await getEmailHeadersPartial(accountId, 'INBOX', COUNT);
        if (!live) return;
        if (!cached?.emails?.length) continue;
        last = { accountId, rows: cached.emails.slice(0, COUNT).map(email => ({ ...email, _accountId: accountId, _mailbox: 'INBOX' })) };
        setRows(last.rows);
        return;
      }
      last = null;
      setRows(castRows(order[0] || 'sample'));
    })();
    return () => { live = false; };
  }, [idsKey]);

  return useMemo(() => {
    const state = useMailStore.getState();
    const listed = new Map((emails || EMPTY).map(email => [emailScopeKey(email, state), email.flags]));
    return rows.map(row => {
      const flags = listed.get(emailScopeKey(row, state));
      return flags && String(flags) !== String(row.flags) ? { ...row, flags } : row;
    });
  }, [rows, emails]);
}
