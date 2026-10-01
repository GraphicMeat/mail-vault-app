import { create } from 'zustand';
import { EMPTY_DICTIONARY } from './piiDetector';

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
