import { hasPremiumAccess, useSettingsStore } from '../../../stores/settingsStore';
import { usePrivacyStore } from '../../../stores/privacyStore';
import { ensurePrivacyDictionary, collectPrivacyNames } from '../../../utils/privacy/privacyDictionary';
import { buildNameDictionary, unionDictionaries } from '../../../utils/privacy/piiDetector';
import { redactTree } from '../../../utils/privacy/redactDom';
import { prepareSocialMessage } from '../exportService';
import { renderMessageToCanvas } from '../renderMessageToCanvas';
import { redactMessageForExport } from '../exportRedact';
import { singleName } from '../exportNaming';
import { captureAppWindow } from './captureAppWindow';
import { composeSocialImage } from './composeSocialImage';
import { SIZE_PRESETS } from './socialLayout';

const asDate = (value) => (value instanceof Date ? value : new Date(value));

// The host's dictionary (dictWanted builds it without masking the UI), plus
// the message's own parties, which a cold host may not know yet.
async function socialDictionary(message) {
  const { setDictWanted } = usePrivacyStore.getState();
  setDictWanted(true);
  try {
    const host = await ensurePrivacyDictionary();
    return unionDictionaries(host, buildNameDictionary({ names: collectPrivacyNames({ emails: [message] }) }));
  } finally {
    setDictWanted(false);
  }
}

// A dark email card is not offered (ruling R16): the export frame has no Dark
// Reader, so only the app window, which captures the live themed UI, can be dark.
export const effectiveTheme = (content, theme) => (content === 'app' && theme === 'dark' ? 'dark' : 'light');

/**
 * The content canvas alone (card render or app capture, redacted when asked).
 * The panel caches it per (content, redact, theme) and re-composes on style
 * changes. `dict` skips a second dictionary wait when the caller has one.
 * ponytail: `theme` does not change either content today (the card is always
 * light, the app shot is the live UI); kept in the signature for the cache key.
 */
export async function buildSocialContent(message, { content, redact, dict } = {}) {
  const dated = { ...message, date: asDate(message.date) };
  const d = redact ? (dict ?? await socialDictionary(dated)) : null;
  if (content === 'app') return captureAppWindow({ redact: !!redact, dict: d });
  const prepared = await prepareSocialMessage(dated, { mirror: true, redact: redact ? { dict: d, format: 'image' } : null });
  return renderMessageToCanvas({
    message: prepared.message,
    bodyHtml: prepared.body,
    redactStyle: redact ? 'blur' : undefined,
    onCloneNode: redact ? (clone) => { redactTree(clone, d); } : undefined,
  });
}

const toBase64 = (canvas) => {
  const url = canvas.toDataURL('image/png');
  return url.slice(url.indexOf(',') + 1);
};

/**
 * `options = { content: 'card'|'app', size: keyof SIZE_PRESETS, background,
 * padding, radius, shadow, chrome, theme, redact }`.
 */
export async function buildSocialExport({ message, options }) {
  if (!hasPremiumAccess(useSettingsStore.getState().billingProfile)) return { ok: false, reason: 'premium' };
  const dated = { ...message, date: asDate(message.date) };
  try {
    const dict = options.redact ? await socialDictionary(dated) : null;
    const content = await buildSocialContent(dated, { content: options.content, redact: options.redact, theme: options.theme, dict });
    const canvas = composeSocialImage({
      content,
      size: SIZE_PRESETS[options.size] ?? null,
      background: options.background,
      padding: options.padding,
      radius: options.radius,
      shadow: options.shadow,
      chrome: options.chrome,
      theme: effectiveTheme(options.content, options.theme),
      fit: options.content === 'app' ? 'contain' : 'crop',
    });
    const named = options.redact ? redactMessageForExport(dated, dict) : dated;
    const name = singleName(named, 'png').replace(/\.png$/, ' - social.png');
    return { ok: true, file: { name, base64: toBase64(canvas) }, canvas };
  } catch (err) {
    return { ok: false, reason: 'render', error: String(err?.message || err) };
  }
}
