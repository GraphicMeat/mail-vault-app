// Network Activity's pure helpers, shared by desktop's store (stores/netActivityStore.js) and the
// page's view (components/settings/views/NetworkActivityView.jsx), which the phone renders too.

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/** The time ranges the page offers, longest last. */
export const RANGES = { hour: HOUR, day: DAY, week: 7 * DAY, twoWeeks: 14 * DAY, month: 30 * DAY };
/** How long the daemon keeps events: its `net_log::Retention`. */
export const RETENTIONS = ['day', 'week', 'twoWeeks', 'month'];

/** The ranges a period of `retention` can answer. */
export const rangesFor = retention => Object.keys(RANGES).filter(r => RANGES[r] <= RANGES[retention]);

export const PROTOCOL_LABELS = { imap: 'IMAP', smtp: 'SMTP', https: 'HTTPS', http: 'HTTP', dns: 'DNS', tcpProbe: 'TCP' };

export const filterEvents = (events, { protocol, purpose, account } = {}) => events.filter(e =>
  (!protocol || e.protocol === protocol) && (!purpose || e.purpose === purpose) && (!account || e.account === account));

/** Where a row went: `host:port`, or `name -> answer` for a lookup. */
export const target = (e, arrow = '->') => (e.protocol === 'dns' ? `${e.host} ${arrow} ${e.ip || '?'}` : `${e.host}:${e.port}`);

/**
 * Plain, untranslated text for a bug report or a support thread. `noAccount`
 * is what the page shows for a connection no account made.
 */
export const copyText = (rows, noAccount = '-') => rows.map(e => [
  new Date(e.atMs).toISOString(), e.direction, PROTOCOL_LABELS[e.protocol] || e.protocol, target(e), e.purpose,
  e.account || noAccount, `up ${e.bytesUp} B`, `down ${e.bytesDown} B`, `${e.durationMs} ms`, e.result,
].join('\t')).join('\n');

