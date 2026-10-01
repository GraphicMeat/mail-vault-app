import { create } from 'zustand';
import { EMPTY_DICTIONARY } from './piiDetector';
import { usePrivacyStore } from '../../stores/privacyStore';

/**
 * The names privacy mode masks: everyone in the contacts index, every party on
 * every loaded header (so the message on screen is covered before the index
 * finishes loading), and the user's own account names (signatures).
 *
 * A module value plus a tiny version store: readers that run outside React
 * (the iframe pass, notify()) read the value directly, and React reruns on
 * `version`.
 */
let current = EMPTY_DICTIONARY;
export const usePrivacyDictStore = create(() => ({ version: 0, ready: false }));

const PARTY_FIELDS = ['from', 'to', 'cc', 'bcc', 'replyTo'];
function partyName(p) {
  if (!p) return '';
  if (typeof p === 'object') return p.name || '';
  const m = /^\s*"?(.*?)"?\s*<[^>]+>\s*$/.exec(String(p));
  return m ? m[1] : '';
}

export function collectPrivacyNames({ contacts = [], emails = [], accounts = [], displayNames = {} } = {}) {
  const out = new Set();
  for (const c of contacts) if (c?.name) out.add(c.name);
  for (const e of emails) {
    for (const f of PARTY_FIELDS) {
      const v = e?.[f];
      for (const p of Array.isArray(v) ? v : [v]) { const n = partyName(p); if (n) out.add(n); }
    }
  }
  for (const a of accounts) if (a?.name) out.add(a.name);
  for (const n of Object.values(displayNames || {})) if (n) out.add(n);
  return [...out];
}

export function setPrivacyDictionary(dict, { ready }) {
  current = dict || EMPTY_DICTIONARY;
  usePrivacyDictStore.setState(s => ({ version: s.version + 1, ready: !!ready }));
}
export const getPrivacyDictionary = () => current;
export const isPrivacyDictionaryReady = () => usePrivacyDictStore.getState().ready;

// An export waits under its busy spinner; a cold contacts index can take seconds.
export const EXPORT_DICTIONARY_WAIT_MS = 10_000;

// Exports waiting at once (an export and a social preview can overlap): the
// flag drops when the last one is done, never under another.
let wanters = 0;
// The version when the flag woke an idle host, or null when the host was
// already running. A ready flag from before the wake may describe an index
// that changed since: such a wait is for the next build, not that flag.
let wokeAt = null;

/**
 * The name dictionary for a redacted export, without masking the UI: raises
 * dictWanted (the host builds while it is up) and resolves once the dictionary
 * is ready, or after timeoutMs with what it has.
 */
export async function ensurePrivacyDictionary(timeoutMs = EXPORT_DICTIONARY_WAIT_MS) {
  const privacy = usePrivacyStore.getState();
  if (wanters++ === 0) {
    // A running host (privacy mode, a capture) keeps the dictionary current.
    wokeAt = privacy.enabled || privacy.captureMask ? null : usePrivacyDictStore.getState().version;
    privacy.setDictWanted(true);
  }
  try {
    const current = s => s.ready && (wokeAt === null || s.version > wokeAt);
    if (!current(usePrivacyDictStore.getState())) {
      await new Promise((resolve) => {
        const timer = setTimeout(done, timeoutMs);
        const un = usePrivacyDictStore.subscribe(s => { if (current(s)) done(); });
        function done() { clearTimeout(timer); un(); resolve(); }
      });
    }
    return getPrivacyDictionary();
  } finally {
    if (--wanters === 0) usePrivacyStore.getState().setDictWanted(false);
  }
}
