/**
 * The notification policy engine. One pure function, no store imports, no
 * `Date.now()` inside — `ctx.now` and `ctx.focusHeld` are supplied by the
 * caller so this stays trivially testable and the caller stays the only
 * place that reads real clocks and store state.
 *
 * Precedence, highest first (each returns its own reason code):
 *   1. focus-hold         — the caller says a Focus session is running. The
 *                            actual hold-and-flush mechanism lives in
 *                            focusStore.js, unchanged; this is just the
 *                            reason code for the decision log.
 *   2. priority-allowlist — sender or domain on the important list.
 *                            Overrides mutes always, and overrides quiet
 *                            hours only when that entry's `throughQuietHours`
 *                            flag is set (defaults true).
 *   3. quiet-hours        — per-account window, local time, may cross
 *                            midnight (22:00-07:00).
 *   4. view-muted         — any of ctx.viewIds is in policy.mutedViewIds.
 *   5. account-muted / folder-not-watched.
 *   6. delivered-default.
 */

// policy.accounts[accountId] -> { enabled, folders, quietHours: { enabled, start, end } }
// policy.mutedViewIds -> [viewId]
// policy.importantSenders -> [{ match, throughQuietHours }]  (match: address or bare domain)

function toMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function inQuietHours(quietHours, now) {
  if (!quietHours?.enabled) return false;
  const start = toMinutes(quietHours.start);
  const end = toMinutes(quietHours.end);
  // ponytail: an invalid or degenerate (start === end) window reads as "never
  // quiet" rather than "always quiet" — a typo should not go silent all day.
  if (start == null || end == null || start === end) return false;
  const d = new Date(now);
  const minutes = d.getHours() * 60 + d.getMinutes();
  return start < end
    ? minutes >= start && minutes < end
    : minutes >= start || minutes < end; // crosses midnight
}

function matchAllowlist(list, from, domain) {
  if (!Array.isArray(list)) return null;
  const f = String(from || '').toLowerCase();
  const d = String(domain || '').toLowerCase();
  return list.find(entry => {
    const m = String(entry?.match || '').toLowerCase().trim();
    return m && (m === f || m === d);
  }) || null;
}

/**
 * @param {{accountId, folder, from, domain, viewIds, tagIds, now, focusHeld}} ctx
 * @param {object} policy - the persisted notificationSettings shape
 * @returns {{deliver: boolean, reason: string}}
 */
export function decide(ctx = {}, policy = {}) {
  const { accountId, folder, from, domain, viewIds, now = Date.now(), focusHeld } = ctx;

  if (focusHeld) return { deliver: false, reason: 'focus-hold' };

  // The master switch is not a mute an important sender may punch through:
  // someone who turned notifications off wants silence, not silence with
  // exceptions they have to remember they configured.
  if (!policy.enabled) return { deliver: false, reason: 'notifications-off' };

  const account = policy.accounts?.[accountId];
  const quiet = inQuietHours(account?.quietHours, now);

  const allowEntry = matchAllowlist(policy.importantSenders, from, domain);
  if (allowEntry) {
    const throughQuietHours = allowEntry.throughQuietHours !== false; // per-entry, defaults true
    if (!quiet || throughQuietHours) return { deliver: true, reason: 'priority-allowlist' };
    // else: allowed sender, but this entry doesn't punch through quiet hours — fall through.
  }

  if (quiet) return { deliver: false, reason: 'quiet-hours' };

  if (Array.isArray(viewIds) && viewIds.some(id => (policy.mutedViewIds || []).includes(id))) {
    return { deliver: false, reason: 'view-muted' };
  }

  if (account) {
    if (!account.enabled) return { deliver: false, reason: 'account-muted' };
    // An unconfigured account defaults to enabled for every folder (today's
    // shouldNotify behavior) — only a configured account's folder list gates.
    if (Array.isArray(account.folders) && !account.folders.includes(folder)) {
      return { deliver: false, reason: 'folder-not-watched' };
    }
  }

  return { deliver: true, reason: 'delivered-default' };
}

const REASON_I18N_KEY = {
  'focus-hold': 'notifyPolicy.reason.focusHold',
  'notifications-off': 'notifyPolicy.reason.notificationsOff',
  'priority-allowlist': 'notifyPolicy.reason.priorityAllowlist',
  'quiet-hours': 'notifyPolicy.reason.quietHours',
  'view-muted': 'notifyPolicy.reason.viewMuted',
  'account-muted': 'notifyPolicy.reason.accountMuted',
  'folder-not-watched': 'notifyPolicy.reason.folderNotWatched',
  'delivered-default': 'notifyPolicy.reason.deliveredDefault',
};

export function reasonI18nKey(reason) {
  return REASON_I18N_KEY[reason] || reason;
}
