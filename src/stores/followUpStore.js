import { create } from 'zustand';
import { daemonCall } from '../services/daemonClient';
import { useSettingsStore } from './settingsStore';
import { normalizeNotificationSound } from '../utils/notificationSounds';
import { t } from '../i18n/index.js';

// Follow-up reminders ("remind me if no reply"). Rows from `follow_up.*`
// (src-daemon/src/handlers/follow_up.rs), modeled on snoozeStore.js: one flat
// list of waiting and due rows, refetched on launch, patched from the
// `follow-up` daemon event. The daemon decides when a row is due; the app
// only shows it.

/// What compose offers, in days.
export const REMIND_DAYS = [1, 3, 7];
export const DAY_MS = 24 * 60 * 60 * 1000;

// The states a row is still shown or still pending in; the rest are history.
const LIVE = new Set(['waiting', 'due']);

export const useFollowUpStore = create((set, get) => ({
  rows: [],

  loadRows: async () => {
    const rows = await daemonCall('follow_up.list', {});
    set({ rows: Array.isArray(rows) ? rows : [] });
    return get().rows;
  },

  /// `{id, state}` off the `follow-up` event. A row that ended is dropped.
  applyEvent: (payload) => {
    if (!payload?.id) return;
    set(state => ({
      rows: LIVE.has(payload.state)
        ? state.rows.map(r => (r.id === payload.id ? { ...r, state: payload.state } : r))
        : state.rows.filter(r => r.id !== payload.id),
    }));
  },

  /// Opened (or marked unread again). The row stays in the list either way.
  setSeen: (id, seen) => {
    const row = get().rows.find(r => r.id === id);
    if (!row || row.seen === seen) return Promise.resolve();
    set(state => ({ rows: state.rows.map(r => (r.id === id ? { ...r, seen } : r)) }));
    return daemonCall('follow_up.mark_seen', { id, seen })
      .catch(err => console.warn('[followUp] could not record the read state:', err));
  },

  /// Done with it: the row leaves the inbox. The Sent copy is never touched.
  dismiss: (id) => {
    set(state => ({ rows: state.rows.filter(r => r.id !== id) }));
    return daemonCall('follow_up.dismiss', { id })
      .catch(err => console.warn('[followUp] could not dismiss the reminder:', err));
  },
}));

/// Rows that are back in the inbox: due, with a Sent copy to open.
export function dueFollowUps(rows) {
  return (rows || []).filter(r => r.state === 'due' && r.sentMailbox && Number.isInteger(r.sentUid));
}

/// The list row a due reminder shows as: the Sent copy, placed where it lives
/// so opening it opens that message, dated at the remind time so every
/// ordering (flat, threads, chat) puts it at the top when it came back.
/// `_followUpId` is what the removal workflows dismiss it by.
export function followUpEmail(row, accountEmail) {
  const remindedAt = new Date(row.remindAt).toISOString();
  return {
    uid: row.sentUid,
    messageId: row.messageId,
    subject: row.subject,
    from: { address: accountEmail || '', name: '' },
    to: row.recipients ? [{ address: row.recipients, name: '' }] : [],
    date: remindedAt,
    internalDate: remindedAt,
    flags: row.seen ? ['\\Seen'] : [],
    _accountId: row.accountId,
    _mailbox: row.sentMailbox,
    _followUpId: row.id,
    _sentAt: row.sentAt,
  };
}

/// The due reminder a row action on (accountId, mailbox, uid) lands on, or
/// null. Only in a list that shows reminders (an inbox, All inboxes): there
/// the Sent copy of a due reminder is never listed as itself (the list's merge
/// of Sent mail drops it by Message-ID), so that location IS the reminder. In
/// the Sent folder it is the real message.
export function followUpAt(view, target) {
  if (!target || !showsFollowUps(view)) return null;
  const rows = dueFollowUps(useFollowUpStore.getState().rows);
  return rows.find(r => r.accountId === target.accountId && r.sentMailbox === target.mailbox
    && r.sentUid === Number(target.uid)) || null;
}

/// Does this view list reminders: an account's INBOX or All inboxes, never a
/// branch listing (its rows are a folder subtree).
export function showsFollowUps(view) {
  if (!view || view.mailboxScope) return false;
  if (view.activeMailbox === 'INBOX') return true;
  return view.activeMailbox === 'UNIFIED' && (view.unifiedFolder || 'INBOX') === 'INBOX';
}

// ── the one notification per reminder ──

const announcing = new Set();

/// Every due row not yet announced gets its banner, once ever: the daemon
/// remembers `announced`, so a relaunch does not repeat it. Through the one
/// notification chokepoint, so a focus session and privacy mode hold it like
/// any mail banner. Loaded late: the list slice imports this store, and the
/// list never needs the banner code.
export async function announceDue() {
  const { notify } = await import('./focusStore');
  const { notificationSettings } = useSettingsStore.getState();
  const sound = normalizeNotificationSound(notificationSettings?.sound);
  for (const row of dueFollowUps(useFollowUpStore.getState().rows)) {
    if (row.announced || announcing.has(row.id)) continue;
    announcing.add(row.id);
    useFollowUpStore.setState(state => ({
      rows: state.rows.map(r => (r.id === row.id ? { ...r, announced: true } : r)),
    }));
    const title = t('followUp.notifyTitle');
    const body = t('followUp.notifyBody', { subject: row.subject || t('common.noSubject'), recipients: row.recipients || '' });
    const target = { accountId: row.accountId, mailbox: 'INBOX' };
    const mailCtx = { accountId: row.accountId, folder: 'INBOX', from: '', domain: '', viewIds: [] };
    try {
      await notify(title, body, sound === 'none' ? undefined : sound, target, mailCtx);
      await daemonCall('follow_up.mark_announced', { id: row.id });
    } catch (err) {
      console.warn('[followUp] could not announce a reminder:', err);
    } finally {
      announcing.delete(row.id);
    }
  }
}

async function listenTo(event, cb) {
  try {
    const { listen } = await import('@tauri-apps/api/event');
    return await listen(event, (e) => cb(e.payload));
  } catch {
    return () => {};
  }
}

let _initialized = false;

/// Called once at app launch (App.jsx, beside initSnooze). A row that went
/// due while the app was closed is announced on launch.
export function initFollowUp() {
  if (_initialized) return;
  _initialized = true;
  useFollowUpStore.getState().loadRows().then(announceDue).catch(() => {});
  listenTo('follow-up', async (payload) => {
    // A due row's event names no Sent copy: read the rows again for it.
    if (payload?.state === 'due') {
      await useFollowUpStore.getState().loadRows().catch(() => {});
      await announceDue();
      return;
    }
    useFollowUpStore.getState().applyEvent(payload);
  });
}

export function _resetFollowUpForTest() {
  _initialized = false;
  announcing.clear();
}
