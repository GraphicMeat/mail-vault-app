// Thin wrapper over the three `ai.*` daemon RPCs (src-daemon/src/handlers/ai.rs)
// plus provider selection from settings. Every AI feature (Quick Replies, AI
// Compose) calls through this — one place that knows the RPC shapes.

import { daemonCall } from './daemonClient';
import { useSettingsStore } from '../stores/settingsStore';

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

/** `{provider, prompt, system?, maxTokens?}` -> generated text. */
export async function generate({ prompt, system, maxTokens, provider } = {}) {
  const p = provider || currentProvider();
  const reply = await daemonCall('ai.generate', { provider: p, prompt, system, maxTokens });
  return reply?.text || '';
}

/** Stores the endpoint API key in the keychain. Never persisted in settings, never echoed back. */
export async function setEndpointKey(key) {
  return daemonCall('ai.set_endpoint_key', { key });
}
