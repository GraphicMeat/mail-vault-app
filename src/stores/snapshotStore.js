/**
 * Snapshot Store — state management for the Time Capsule UI.
 *
 * Manages snapshot list, active manifest, mailbox normalization,
 * lazy email hydration from local Maildir, and read-only email viewer.
 */

import { create } from 'zustand';
import * as snapshotService from '../services/snapshotService.js';
import { send as transportSend } from '../services/transport.js';

const HYDRATE_BATCH = 50;

/**
 * Normalize raw Maildir folder names to app-facing display names.
 * "INBOX.Drafts" → "Drafts", "INBOX.Sent" → "Sent", etc.
 */
function normalizeMailboxName(raw) {
  if (!raw) return raw;
  // Strip "INBOX." prefix (case-insensitive)
  const match = raw.match(/^inbox\./i);
  if (match) return raw.slice(match[0].length);
  return raw;
}

/** Canonical sort order for mailbox tabs. */
const MAILBOX_ORDER = ['INBOX', 'Sent', 'Drafts', 'Trash', 'Junk', 'Archive'];

function mailboxSortKey(name) {
  const idx = MAILBOX_ORDER.indexOf(name);
  return idx >= 0 ? idx : 100;
}

export const useSnapshotStore = create((set, get) => ({
  // Snapshot list
  snapshots: [],
  loadingSnapshots: false,

  // Active snapshot manifest
  activeSnapshot: null,
  loadingSnapshot: false,

  // Mailbox browsing — normalized names + raw path mapping
  selectedMailbox: 'INBOX', // normalized display name
  mailboxMap: {},           // { normalizedName: rawMailboxKey }
  mailboxList: [],          // [{ name, rawKey, totalEmails }] sorted

  // Email list — manifest entries + hydrated metadata
  manifestEmails: [],       // lightweight entries from manifest
  hydratedEmails: {},       // { uid: hydratedEmailData } from Maildir
  hydratingUids: new Set(), // UIDs currently being hydrated

  // Read-only email viewer
  viewerEmail: null,        // full email payload for viewer
  loadingViewer: false,
  selectedEmailUid: null,

  error: null,

  // ── Snapshot list ──────────────────────────────────────────────────────

  loadSnapshots: async (accountId) => {
    set({ loadingSnapshots: true, error: null });
    try {
      const snapshots = await snapshotService.listSnapshots(accountId);
      set({ snapshots, loadingSnapshots: false });
    } catch (e) {
      set({ loadingSnapshots: false, error: e.message });
    }
  },

  openSnapshot: async (accountId, filename) => {
    set({ loadingSnapshot: true, error: null, selectedEmailUid: null, viewerEmail: null });
    try {
      const manifest = await snapshotService.loadSnapshot(accountId, filename);

      // Build normalized mailbox map
      const mailboxMap = {};
      const mailboxList = [];
      for (const [rawKey, data] of Object.entries(manifest.mailboxes || {})) {
        const normalized = normalizeMailboxName(rawKey);
        mailboxMap[normalized] = rawKey;
        mailboxList.push({ name: normalized, rawKey, totalEmails: data.total_emails });
      }
      mailboxList.sort((a, b) => mailboxSortKey(a.name) - mailboxSortKey(b.name));

      const defaultMailbox = mailboxList.find(m => m.name === 'INBOX')?.name || mailboxList[0]?.name || 'INBOX';
      const rawDefault = mailboxMap[defaultMailbox] || defaultMailbox;
      const emails = manifest.mailboxes?.[rawDefault]?.emails || [];

      set({
        activeSnapshot: manifest,
        loadingSnapshot: false,
        selectedMailbox: defaultMailbox,
        mailboxMap,
        mailboxList,
        manifestEmails: emails,
        hydratedEmails: {},
        hydratingUids: new Set(),
      });
    } catch (e) {
      set({ loadingSnapshot: false, error: e.message });
    }
  },

  closeSnapshot: () => {
    set({
      activeSnapshot: null, selectedEmailUid: null, viewerEmail: null,
      selectedMailbox: 'INBOX', mailboxMap: {}, mailboxList: [],
      manifestEmails: [], hydratedEmails: {}, hydratingUids: new Set(),
    });
  },

  // ── Mailbox switching ──────────────────────────────────────────────────

  selectMailbox: (normalizedName) => {
    const { activeSnapshot, mailboxMap } = get();
    const rawKey = mailboxMap[normalizedName] || normalizedName;
    const emails = activeSnapshot?.mailboxes?.[rawKey]?.emails || [];
    set({
      selectedMailbox: normalizedName,
      manifestEmails: emails,
      hydratedEmails: {},
      hydratingUids: new Set(),
      selectedEmailUid: null,
      viewerEmail: null,
    });
  },

  // ── Lazy hydration ─────────────────────────────────────────────────────

  /**
   * Hydrate visible rows from local Maildir. Call when the visible window changes.
   * @param {string} accountId
   * @param {number[]} visibleUids - UIDs currently in the viewport
   */
  hydrateVisibleRows: async (accountId, visibleUids) => {
    const { hydratedEmails, hydratingUids, selectedMailbox, mailboxMap } = get();
    const rawMailbox = mailboxMap[selectedMailbox] || selectedMailbox;

    // Filter to UIDs that need hydration
    const needed = visibleUids.filter(uid => !hydratedEmails[uid] && !hydratingUids.has(uid));
    if (needed.length === 0) return;

    // Mark as in-flight
    const newHydrating = new Set(hydratingUids);
    needed.forEach(uid => newHydrating.add(uid));
    set({ hydratingUids: newHydrating });

    // Batch read from Maildir
    try {
      const invoke = transportSend;

      for (let i = 0; i < needed.length; i += HYDRATE_BATCH) {
        const batch = needed.slice(i, i + HYDRATE_BATCH);
        const results = await invoke('maildir_read_light_batch', {
          accountId,
          mailbox: rawMailbox,
          uids: batch,
        });

        if (Array.isArray(results)) {
          const updated = { ...get().hydratedEmails };
          for (const email of results) {
            if (email && email.uid) {
              updated[email.uid] = email;
            }
          }
          set({ hydratedEmails: updated });
        }
      }
    } catch (e) {
      // Hydration failure is non-fatal — manifest data stays as fallback
      console.warn('[snapshotStore] Hydration failed:', e);
    }

    // Clear in-flight markers
    const clearedHydrating = new Set(get().hydratingUids);
    needed.forEach(uid => clearedHydrating.delete(uid));
    set({ hydratingUids: clearedHydrating });
  },

  // ── Email viewer ───────────────────────────────────────────────────────

  /**
   * Open a snapshot email in the read-only viewer.
   */
  openEmail: async (accountId, uid) => {
    const { selectedMailbox, mailboxMap } = get();
    const rawMailbox = mailboxMap[selectedMailbox] || selectedMailbox;
    set({ selectedEmailUid: uid, loadingViewer: true, viewerEmail: null });

    try {
      // Try full read first (includes body + attachments)
      const email = await transportSend('maildir_read', { accountId, mailbox: rawMailbox, uid });
      set({ viewerEmail: email, loadingViewer: false });
    } catch (e) {
      // Fall back to light read
      try {
        const email = await transportSend('maildir_read_light', { accountId, mailbox: rawMailbox, uid });
        set({ viewerEmail: email, loadingViewer: false });
      } catch (e2) {
        console.warn('[snapshotStore] Failed to load email:', e2);
        set({ loadingViewer: false, error: `Could not load email: ${e2.message || e.message}` });
      }
    }
  },

  closeViewer: () => {
    set({ selectedEmailUid: null, viewerEmail: null, loadingViewer: false });
  },

  // ── Helpers ────────────────────────────────────────────────────────────

  /**
   * Get merged email list: hydrated data preferred, manifest as fallback.
   */
  getMergedEmails: () => {
    const { manifestEmails, hydratedEmails } = get();
    return manifestEmails.map(e => hydratedEmails[e.uid] || e);
  },

  getActiveMailboxes: () => get().mailboxList,

  // ── CRUD ───────────────────────────────────────────────────────────────

  createSnapshot: async (accountId, accountEmail) => {
    set({ error: null });
    try {
      await snapshotService.createSnapshotFromMaildir(accountId, accountEmail);
      await get().loadSnapshots(accountId);
    } catch (e) {
      set({ error: e.message });
    }
  },

  deleteSnapshot: async (accountId, filename) => {
    set({ error: null });
    try {
      await snapshotService.deleteSnapshot(accountId, filename);
      if (get().activeSnapshot && get().snapshots.find(s => s.filename === filename)) {
        get().closeSnapshot();
      }
      await get().loadSnapshots(accountId);
    } catch (e) {
      set({ error: e.message });
    }
  },

  selectEmail: (uid) => set({ selectedEmailUid: uid }),

  reset: () => {
    set({
      snapshots: [], activeSnapshot: null, loadingSnapshots: false, loadingSnapshot: false,
      selectedMailbox: 'INBOX', mailboxMap: {}, mailboxList: [],
      manifestEmails: [], hydratedEmails: {}, hydratingUids: new Set(),
      selectedEmailUid: null, viewerEmail: null, loadingViewer: false, error: null,
    });
  },
}));
