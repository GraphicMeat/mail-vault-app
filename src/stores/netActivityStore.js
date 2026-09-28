import { create } from 'zustand';
import { listen } from '@tauri-apps/api/event';
import { daemonCall } from '../services/daemonClient';
import { scanTrackers } from '../utils/trackerDetect';
import { bodyStamp } from '../utils/linkSafety';

// Settings > Privacy > Network Activity. The daemon keeps the events (in
// app.db on this Mac, for the period the user chose); this only mirrors what
// the page asks for while it is open: `net.activity` for the newest 2,000
// matching the time range, account and country, `net-activity` for each new
// one, `net.geo` and `net.summary` for the map and the totals over the whole
// range. Rows stay in arrival order: an event's `atMs` is when its connection
// STARTED and it is recorded when it closes, so a long IMAP session arrives
// last with the oldest time. Never sort by `atMs`.
const MAX_ROWS = 2000;
/** The map and the totals follow new rows at most this often. */
const AGGREGATE_EVERY_MS = 5000;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/** The time ranges the page offers, longest last. */
export const RANGES = { hour: HOUR, day: DAY, week: 7 * DAY, twoWeeks: 14 * DAY, month: 30 * DAY };
/** How long the daemon keeps events: its `net_log::Retention`. */
export const RETENTIONS = ['day', 'week', 'twoWeeks', 'month'];
const DEFAULT_RETENTION = 'week';

/** The ranges a period of `retention` can answer. */
export const rangesFor = retention => Object.keys(RANGES).filter(r => RANGES[r] <= RANGES[retention]);
/** `range`, or the longest one `retention` still covers. */
const clampRange = (range, retention) => (RANGES[range] <= RANGES[retention] ? range : rangesFor(retention).at(-1));

export const PROTOCOL_LABELS = { imap: 'IMAP', smtp: 'SMTP', https: 'HTTPS', http: 'HTTP', dns: 'DNS', tcpProbe: 'TCP' };

/** What the daemon filters on. `country` narrows the table only. */
const params = ({ range, account, country }, withCountry) => ({
  sinceMs: Date.now() - RANGES[range],
  ...(account ? { account } : {}),
  ...(withCountry && country ? { country } : {}),
});

/** Whether a live event belongs on the table the query shows. */
const matches = (e, { range, account, country }) =>
  e.atMs >= Date.now() - RANGES[range] && (!account || e.account === account) && (!country || e.country === country);

// One page open at a time: its reload and pending aggregate refresh.
let reload = null;
let aggregateTimer = null;
const EMPTY_SUMMARY = { hosts: 0, sent: 0, received: 0, accounts: [] };

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
  /** What the table, the map and the totals show. */
  query: { range: 'day', account: '', country: '' },
  retention: DEFAULT_RETENTION,
  retentionError: false,
  /** `net.geo`: one entry per country (and `local`), most connections first. */
  places: [],
  summary: EMPTY_SUMMARY,

  add: ev => {
    if (!matches(ev, get().query)) return;
    set(s => ({ events: [withId(ev), ...s.events].slice(0, MAX_ROWS) }));
  },
  pause: () => set(s => ({ frozen: s.events })),
  resume: () => set({ frozen: null }),

  /** The map and totals for the current query. A failed read keeps the last. */
  loadAggregates: async () => {
    const q = get().query;
    try {
      const [geo, summary] = await Promise.all([
        daemonCall('net.geo', params(q, false)),
        daemonCall('net.summary', params(q, false)),
      ]);
      if (get().query !== q) return;
      set({ places: geo?.countries || [], summary: { ...EMPTY_SUMMARY, ...summary } });
    } catch (e) {
      console.warn('[network-activity] totals failed:', e);
    }
  },

  /** Change the range, account or country: everything on the page follows. */
  setQuery: patch => {
    set(s => ({ query: { ...s.query, ...patch } }));
    void reload?.();
  },

  /** Keep events for `retention`; the daemon prunes to it at once. */
  setRetention: async retention => {
    try {
      await daemonCall('net.set_retention', { retention });
    } catch (e) {
      console.warn('[network-activity] retention failed:', e);
      set({ retentionError: true });
      return;
    }
    set({ retention, retentionError: false });
    get().setQuery({ range: clampRange(get().query.range, retention) });
  },

  /**
   * Listen, then ask for the snapshot: the other order loses whatever is
   * recorded between the reply and the listener. An event that arrives while
   * the snapshot is in flight may be in it too, so it is added only when not.
   * A reconnected daemon may be a new one, so it gets a fresh snapshot too;
   * so does every change of the query, and only the newest answer is shown.
   * Returns the stop function, which also covers a listener still being set
   * up, and clears the rows so the next visit never opens on this one's.
   */
  start: () => {
    let stopped = false;
    const unlistens = [];
    let early = [];
    let asked = 0;
    const onEvent = ev => {
      if (early) early.push(ev); else get().add(ev);
      // The map and totals catch up with new rows, but not once per row.
      if (!aggregateTimer) {
        aggregateTimer = setTimeout(() => { aggregateTimer = null; if (!stopped) void get().loadAggregates(); }, AGGREGATE_EVERY_MS);
      }
    };
    const on = async (name, cb) => {
      try {
        const stop = await listen(name, e => { if (!stopped) cb(e.payload); });
        if (stopped) stop(); else unlistens.push(stop);
      } catch { /* no Tauri here: the snapshot is all there is */ }
    };
    const snapshot = async () => {
      const mine = ++asked;
      const q = get().query;
      early = early || [];
      void get().loadAggregates();
      let events = null;
      try {
        events = (await daemonCall('net.activity', params(q, true)))?.events || [];
      } catch { /* shown as loadError below */ }
      if (stopped || mine !== asked) return;
      const seen = new Set((events || []).map(eventKey));
      const arrived = (early || []).filter(e => !seen.has(eventKey(e)) && matches(e, q)).reverse();
      early = null;
      const rows = [...arrived, ...(events || [])].slice(0, MAX_ROWS).map(withId);
      // A paused table that changes its query shows the new rows, still paused.
      set(s => ({ events: rows, frozen: s.frozen && rows, loadError: !events }));
    };
    const retention = async () => {
      try {
        const r = (await daemonCall('net.retention'))?.retention;
        if (stopped || !RETENTIONS.includes(r)) return;
        const range = clampRange(get().query.range, r);
        set({ retention: r });
        if (range !== get().query.range) get().setQuery({ range });
      } catch { /* the default stands */ }
    };
    reload = snapshot;
    void (async () => {
      await on('net-activity', onEvent);
      await on('daemon-reconnected', () => { void snapshot(); });
      if (!stopped) await Promise.all([snapshot(), retention()]);
    })();
    return () => {
      stopped = true;
      if (reload === snapshot) reload = null;
      clearTimeout(aggregateTimer);
      aggregateTimer = null;
      unlistens.splice(0).forEach(stop => stop());
      set({ events: [], frozen: null, places: [], summary: EMPTY_SUMMARY });
    };
  },

  noteRemoteImages: (blocked, loaded) => set(s => ({
    remoteImages: { blocked: s.remoteImages.blocked + blocked, loaded: s.remoteImages.loaded + loaded },
  })),
}));

export const visibleEvents = s => s.frozen || s.events;

export const filterEvents = (events, { protocol, purpose, account } = {}) => events.filter(e =>
  (!protocol || e.protocol === protocol) && (!purpose || e.purpose === purpose) && (!account || e.account === account));

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
