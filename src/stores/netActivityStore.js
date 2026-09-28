import { create } from 'zustand';
import { listen } from '@tauri-apps/api/event';
import { daemonCall } from '../services/daemonClient';
import { scanTrackers } from '../utils/trackerDetect';
import { bodyStamp } from '../utils/linkSafety';

// Settings > Privacy > Network Activity. The daemon keeps the list (a
// 2,000-event ring in memory, never saved); this only mirrors it while the
// page is open: `net.activity` for what is there, `net-activity` for each new
// one. Rows stay in arrival order: an event's `atMs` is when its connection
// STARTED and it is recorded when it closes, so a long IMAP session arrives
// last with the oldest time. Never sort by `atMs`.
const MAX_ROWS = 2000;

export const PROTOCOL_LABELS = { imap: 'IMAP', smtp: 'SMTP', https: 'HTTPS', http: 'HTTP', dns: 'DNS', tcpProbe: 'TCP' };

// Good enough to tell one event from another: two different connections with
// the same start, target and byte counts are not a real case.
const eventKey = e => `${e.atMs}|${e.protocol}|${e.host}|${e.port}|${e.purpose}|${e.bytesUp}|${e.bytesDown}|${e.durationMs}|${e.result}`;

// A row id, so a new row on top re-renders that row only.
let seq = 0;
const withId = e => ({ ...e, id: ++seq });

export const useNetActivityStore = create((set, get) => ({
  events: [],
  /** The rows Pause holds on screen; null while live. */
  frozen: null,
  loadError: false,
  /** Remote images in the mail this window rendered, counted by `frameBody`. */
  remoteImages: { blocked: 0, loaded: 0 },

  add: ev => set(s => ({ events: [withId(ev), ...s.events].slice(0, MAX_ROWS) })),
  pause: () => set(s => ({ frozen: s.events })),
  resume: () => set({ frozen: null }),

  /**
   * Listen, then ask for the snapshot: the other order loses whatever is
   * recorded between the reply and the listener. An event that arrives while
   * the snapshot is in flight may be in it too, so it is added only when not.
   * A reconnected daemon is a restarted one with an empty ring, so it gets a
   * fresh snapshot too. Returns the stop function, which also covers a
   * listener still being set up, and clears the rows so the next visit never
   * opens on this one's.
   */
  start: () => {
    let stopped = false;
    const unlistens = [];
    let early = [];
    const onEvent = ev => { if (early) early.push(ev); else get().add(ev); };
    const on = async (name, cb) => {
      try {
        const stop = await listen(name, e => { if (!stopped) cb(e.payload); });
        if (stopped) stop(); else unlistens.push(stop);
      } catch { /* no Tauri here: the snapshot is all there is */ }
    };
    const snapshot = async () => {
      early = early || [];
      let events = null;
      try {
        events = (await daemonCall('net.activity'))?.events || [];
      } catch { /* shown as loadError below */ }
      if (stopped) return;
      const seen = new Set((events || []).map(eventKey));
      const arrived = (early || []).filter(e => !seen.has(eventKey(e))).reverse();
      early = null;
      set({ events: [...arrived, ...(events || [])].slice(0, MAX_ROWS).map(withId), loadError: !events });
    };
    void (async () => {
      await on('net-activity', onEvent);
      await on('daemon-reconnected', () => { void snapshot(); });
      if (!stopped) await snapshot();
    })();
    return () => {
      stopped = true;
      unlistens.splice(0).forEach(stop => stop());
      set({ events: [], frozen: null });
    };
  },

  noteRemoteImages: (blocked, loaded) => set(s => ({
    remoteImages: { blocked: s.remoteImages.blocked + blocked, loaded: s.remoteImages.loaded + loaded },
  })),
}));

export const visibleEvents = s => s.frozen || s.events;

export const filterEvents = (events, { protocol, purpose, account } = {}) => events.filter(e =>
  (!protocol || e.protocol === protocol) && (!purpose || e.purpose === purpose) && (!account || e.account === account));

/**
 * Today's rows only: the daemon's ring can span days, and it is capped and
 * starts empty on a restart, so this is never a full-day total. A host counts when MailVault
 * reached out to it; a lookup reaches the resolver, not the host it names,
 * and an inbound hit is someone reaching MailVault.
 */
export function summarize(events, now = Date.now()) {
  const start = new Date(now).setHours(0, 0, 0, 0);
  const today = events.filter(e => e.atMs >= start);
  return {
    hosts: new Set(today.filter(e => e.direction === 'out' && e.protocol !== 'dns').map(e => e.host)).size,
    sent: today.reduce((sum, e) => sum + (e.bytesUp || 0), 0),
    received: today.reduce((sum, e) => sum + (e.bytesDown || 0), 0),
  };
}

/** Where a row went: `host:port`, or `name -> answer` for a lookup. */
export const target = (e, arrow = '->') => (e.protocol === 'dns' ? `${e.host} ${arrow} ${e.ip || '?'}` : `${e.host}:${e.port}`);

/** Plain, untranslated text for a bug report or a support thread. */
export const copyText = rows => rows.map(e => [
  new Date(e.atMs).toISOString(), e.direction, PROTOCOL_LABELS[e.protocol] || e.protocol, target(e), e.purpose,
  e.account || '-', `up ${e.bytesUp} B`, `down ${e.bytesDown} B`, `${e.durationMs} ms`, e.result,
].join('\t')).join('\n');

// ponytail: one small entry per message rendered this session; cap it if a
// session ever renders millions.
const counted = new Map();

/**
 * The body a message frame renders: the cleaned one when tracker blocking is
 * on. Every mail renderer goes through here so the page's remote-images line
 * counts each message once, whichever view showed it. Loaded means allowed
 * to load: an https `<img>` left in the body (the app's CSP allows no plain
 * http image). Keyless previews are told apart by their body. A message whose
 * preview body is later replaced by the full one under the same key adds only
 * what the full body has beyond what was already counted.
 */
export function frameBody(bodyHtml, key, blocking) {
  const scan = scanTrackers(bodyHtml, key);
  const body = blocking ? scan.cleanedBodyHtml : bodyHtml;
  const id = key || (bodyHtml ? bodyStamp(bodyHtml) : '');
  if (id) {
    const trackers = scan.trackers || [];
    const httpsTrackers = trackers.filter(tr => /^https:/i.test(tr.url || '')).length;
    const now = {
      blocked: blocking ? trackers.length : 0,
      loaded: (scan.https || 0) - (blocking ? httpsTrackers : 0),
    };
    const before = counted.get(id) || { blocked: 0, loaded: 0 };
    const blocked = Math.max(0, now.blocked - before.blocked);
    const loaded = Math.max(0, now.loaded - before.loaded);
    counted.set(id, { blocked: Math.max(now.blocked, before.blocked), loaded: Math.max(now.loaded, before.loaded) });
    // Deferred: renderers call this while rendering, and a store write
    // there is an update of another component (this page) mid-render.
    if (blocked || loaded) queueMicrotask(() => useNetActivityStore.getState().noteRemoteImages(blocked, loaded));
  }
  return { scan, body };
}
