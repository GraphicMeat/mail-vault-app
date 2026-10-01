// Thin wrapper over the three `ai.*` daemon RPCs (src-daemon/src/handlers/ai.rs)
// plus provider selection from settings. Every AI feature (Quick Replies, AI
// Compose) calls through this — one place that knows the RPC shapes.
//
// Gmail rule: mail from a Google account is only ever processed by on-device
// AI (Apple's model, the downloaded model, or an endpoint on this computer).
// Every request that carries mail therefore names the accounts it came from
// (`accountIds`), and `providerForMail` swaps a cloud endpoint for an on-device
// provider when one of them is a Google account, or says there is none. The
// daemon enforces the same rule (src-daemon/src/ai_gate.rs) and is the real
// guarantee; this is so the UI never even tries.

import { daemonCall } from './daemonClient';
import { useSettingsStore } from '../stores/settingsStore';
import { getAccounts } from '../stores/accountStore';

// A handful of existing ComposeModal/EmailViewer specs stub the whole
// settingsStore module with a hand-built object that predates aiSettings —
// a bare local fallback (not imported from settingsStore.js) so this module
// still works under those mocks instead of only under the real store.
const FALLBACK_AI_SETTINGS = { enabled: false, provider: 'localGguf', endpointUrl: '', endpointModel: '', endpointConsented: false };

/** The daemon's `Provider` enum shape, from the user's provider setting. */
export function currentProvider(aiSettings) {
  const s = aiSettings || useSettingsStore.getState().aiSettings || FALLBACK_AI_SETTINGS;
  if (s.provider === 'endpoint') {
    return { type: 'endpoint', url: s.endpointUrl || '', model: s.endpointModel || '' };
  }
  if (s.provider === 'appleFm') return { type: 'appleFm' };
  return { type: 'localGguf' };
}

export function isNonLocal(provider) {
  return provider?.type === 'endpoint';
}

// ── Gmail mail stays on this device ─────────────────────────────────────────

/** The daemon's refusal code (src-core ai::GOOGLE_MAIL_ON_DEVICE_ONLY). */
export const E_GOOGLE_MAIL_ON_DEVICE_ONLY = 'E_GOOGLE_MAIL_ON_DEVICE_ONLY';
const GOOGLE_MAIL_KEY = 'ai.googleMailOnDeviceOnly';

/** Mirror of src-core `ai::is_google_account`: Google OAuth, or IMAP on one of Gmail's hosts. */
export function isGoogleAccount(account) {
  const text = value => (typeof value === 'string' ? value : '').trim().toLowerCase();
  const host = text(account?.imapHost).replace(/\.$/, '');
  return (text(account?.authType) === 'oauth2' && text(account?.oauth2Provider) === 'google')
    || host === 'imap.gmail.com' || host === 'imap.googlemail.com';
}

/** Mirror of src-core `ai::endpoint_is_on_device`: the host is localhost, 127.0.0.0/8 or ::1. */
export function endpointIsOnDevice(url) {
  let parsed;
  try { parsed = new URL(String(url || '').trim()); } catch { return false; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  return host === 'localhost'
    || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
    || host === '[::1]'
    || /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(host);
}

/** Whether Gmail mail may be given to this provider. */
export function isOnDevice(provider) {
  if (provider?.type === 'endpoint') return endpointIsOnDevice(provider.url);
  return provider?.type === 'appleFm' || provider?.type === 'localGguf';
}

/**
 * The account ids a set of messages came from. A message that carries no
 * `_accountId` or `_srcAccountId` (a single-account folder) belongs to `fallbackAccountId`, the
 * account being read. Duplicates collapse; an id that cannot be named is
 * left out, which `mailMustStayOnDevice` then reads as "unknown".
 */
export function accountIdsOf(messages, fallbackAccountId) {
  const ids = (Array.isArray(messages) ? messages : [messages])
    .map(message => message?._accountId || message?._srcAccountId || fallbackAccountId)
    .filter(Boolean);
  return [...new Set(ids)];
}

/**
 * Whether mail from these accounts may only go to an on-device provider: any
 * of them is a Google account, or cannot be found (the daemon's own rule), or
 * no account was named at all.
 */
export function mailMustStayOnDevice(accountIds, accounts = getAccounts()) {
  const ids = (accountIds || []).filter(Boolean);
  if (!ids.length) return true;
  const known = new Map((accounts || []).map(a => [a.id, a]));
  return ids.some(id => !known.has(id) || isGoogleAccount(known.get(id)));
}

/** First available on-device provider: Apple's model, else the downloaded one. */
async function availableOnDeviceProvider() {
  let list = [];
  try { list = await listProviders(''); } catch { /* daemon unreachable: nothing is available */ }
  for (const type of ['appleFm', 'localGguf']) {
    if (list.find(p => p.provider === type)?.available) return { type };
  }
  return null;
}

/**
 * The provider that may be given mail from `accountIds`. A cloud endpoint is
 * kept for mail that is not Google's; for Google mail it is swapped for an
 * available on-device provider, or `{ refused: true }` when there is none.
 * `{ provider, switched, refused }`.
 */
export async function providerForMail(provider, accountIds, { accounts } = {}) {
  if (isOnDevice(provider) || !mailMustStayOnDevice(accountIds, accounts)) {
    return { provider, switched: false, refused: false };
  }
  const fallback = await availableOnDeviceProvider();
  return fallback
    ? { provider: fallback, switched: true, refused: false }
    : { provider: null, switched: false, refused: true };
}

/** The error a refused request throws: its message starts with the daemon's own code. */
export function googleMailRefusal() {
  const error = new Error(`${E_GOOGLE_MAIL_ON_DEVICE_ONLY}: Gmail messages are only processed by on-device AI.`);
  error.code = E_GOOGLE_MAIL_ON_DEVICE_ONLY;
  return error;
}

/**
 * Catalog text for an error that came out of `generate`, or `fallback` for any
 * other. The daemon's refusal starts with its `E_*` code, like every other
 * service-layer error that reaches the UI.
 */
export function aiErrorText(error, t, fallback) {
  const message = String(error?.message ?? error ?? '');
  if (message.startsWith(E_GOOGLE_MAIL_ON_DEVICE_ONLY)) return t(GOOGLE_MAIL_KEY);
  return fallback ?? message;
}

// ponytail: no caching here — `appleFm`'s status spawns and waits on the
// Swift helper (up to its 60s timeout), and both `AiComposeActions` and
// `QuickReplyChips`' Tier 2 check on every mount, so opening several emails
// in a row while AI is on spawns it that many times. A tried memo (keyed on
// endpoint URL, short TTL) made a stale "unavailable" from one render leak
// into the next component that asked, sight unseen — wrong beats slow here.
// Revisit with real invalidation (on provider/URL change, not a timer) if a
// helper spawn under load ever shows up as a real cost.

/** `[{ provider, available, reason }]` for localGguf, endpoint and appleFm. */
export async function listProviders(endpointUrl = useSettingsStore.getState().aiSettings?.endpointUrl) {
  const reply = await daemonCall('ai.providers', endpointUrl ? { endpointUrl } : {});
  return Array.isArray(reply) ? reply : [];
}

export async function isProviderAvailable(provider) {
  const list = await listProviders(provider?.type === 'endpoint' ? provider.url : undefined);
  return !!list.find(p => p.provider === provider?.type)?.available;
}

/**
 * `{provider, prompt, system?, maxTokens?, accountIds | noMailContent}` ->
 * generated text.
 *
 * Every request says whose mail its prompt carries: `accountIds`, the accounts
 * the message(s) in it came from. A prompt that holds no mail at all (the
 * Settings test) says `noMailContent: true` instead. Neither is a request the
 * daemon would send to a cloud endpoint, and this refuses it here first.
 */
export async function generate({ prompt, system, maxTokens, provider, accountIds, noMailContent } = {}) {
  let p = provider || currentProvider();
  const params = { prompt, system, maxTokens };
  if (noMailContent && !accountIds?.length) {
    params.noMailContent = true;
  } else {
    const resolved = await providerForMail(p, accountIds);
    if (resolved.refused) throw googleMailRefusal();
    p = resolved.provider;
    params.accountIds = accountIds || [];
  }
  const reply = await daemonCall('ai.generate', { provider: p, ...params });
  return reply?.text || '';
}

/** Stores the endpoint API key in the keychain. Never persisted in settings, never echoed back. */
export async function setEndpointKey(key) {
  return daemonCall('ai.set_endpoint_key', { key });
}
