// ── accountPolicy: the daemon's answer to "what does this account keep, and
// what are its daily limits" ──
//
// The daemon decides (`policy.accounts`, src-daemon/src/handlers/policy.rs,
// rules in src-core fetch_mode.rs and transfer_limits.rs) from the settings
// document it owns; the app reads the answer and shows it. Per account:
//   fetch:    null for a hidden account, else { mode, windowMonths,
//             hoarderPremium, vaultHoldsCopies, recentWindowMonths, keep,
//             keepSinceMs } (keep: 'none' | 'all' | 'since').
//   transfer: { gmail, capEnabled, warnEnabled, down, up, today, warning },
//             down/up = { limitBytes, isProviderDefault, defaultCapOn,
//             defaultCapOff }, warning = { direction, fraction } | null.
//
// A settings change reaches the daemon about 500ms after the store changes
// (safeStorage debounces its writes), so a view refetches on the daemon's
// `settings-changed`, never on the store's own change.

import { useEffect, useState } from 'react';
import { send } from './transport';

/** `{ [accountId]: { fetch, transfer } }` for `accounts` (objects with `id`, `imapHost`). */
export async function accountPolicies(accounts) {
  const list = (accounts || [])
    .filter((a) => a?.id)
    .map((a) => ({ id: a.id, imapHost: a.imapHost || '' }));
  if (!list.length) return {};
  const reply = await send('policy.accounts', { accounts: list });
  return reply?.accounts || {};
}

/**
 * Whether the download-ahead fetches a body dated `dateMs` under `fetch`
 * (the daemon's `keep` answer read as it is meant: an unknown date is kept by
 * every mode that keeps anything, as the daemon's download gate keeps it).
 */
export function fetchesAhead(fetch, dateMs) {
  if (!fetch || fetch.keep === 'none') return false;
  if (fetch.keep !== 'since') return true;
  return !Number.isFinite(dateMs) || dateMs >= fetch.keepSinceMs;
}

/**
 * Calls `cb` whenever the daemon's answer may have changed: a settings write
 * landed, or the daemon came back. Returns the unsubscribe.
 */
export function onPolicyInputsChanged(cb) {
  let gone = false;
  const offs = [];
  import('@tauri-apps/api/event')
    .then(({ listen }) => Promise.all(['settings-changed', 'daemon-reconnected'].map((name) => listen(name, () => cb()))))
    .then((us) => { if (gone) us.forEach((u) => u()); else offs.push(...us); })
    .catch(() => {});
  return () => { gone = true; offs.forEach((u) => u()); };
}

/**
 * One account's `{ fetch, transfer }`: `undefined` until the daemon first
 * answers, `null` when it could not answer then (a later failure keeps the
 * last answer).
 */
export function useAccountPolicy(account) {
  const id = account?.id;
  const imapHost = account?.imapHost || '';
  const [policy, setPolicy] = useState(undefined);
  useEffect(() => {
    if (!id) { setPolicy(undefined); return undefined; }
    let live = true;
    let seq = 0;
    const load = () => {
      const mine = ++seq;
      accountPolicies([{ id, imapHost }])
        .then((all) => { if (live && mine === seq) setPolicy(all[id] ?? null); })
        .catch(() => { if (live && mine === seq) setPolicy((p) => (p === undefined ? null : p)); });
    };
    load();
    const off = onPolicyInputsChanged(load);
    return () => { live = false; off(); };
  }, [id, imapHost]);
  return policy;
}
