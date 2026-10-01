import { hasPremiumAccess, useSettingsStore } from '../../../stores/settingsStore';
import { usePrivacyStore } from '../../../stores/privacyStore';
import { useThemeStore } from '../../../stores/themeStore';
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

// The host's dictionary (built without masking the UI), plus the message's
// own parties, which a cold host may not know yet.
async function socialDictionary(message) {
  const host = await ensurePrivacyDictionary();
  return unionDictionaries(host, buildNameDictionary({ names: collectPrivacyNames({ emails: [message] }) }));
}

// The card is always light (ruling R16: the export frame has no Dark Reader).
// The app window is the live themed UI, so its frame follows the app theme.
export const chromeTheme = (content, appTheme) => (content === 'app' && appTheme === 'dark' ? 'dark' : 'light');

// Privacy mode on means redacted, whatever the checkbox says.
const mustRedact = (redact) => !!redact || usePrivacyStore.getState().enabled;

/**
 * The content canvas alone (card render or app capture, redacted when asked).
 * The panel caches it per (content, redact) and re-composes on style changes.
 * `dict` skips a second dictionary wait when the caller has one.
 */
export async function buildSocialContent(message, { content, redact, dict } = {}) {
  const dated = { ...message, date: asDate(message.date) };
  const red = mustRedact(redact);
  const d = red ? (dict ?? await socialDictionary(dated)) : null;
  if (content === 'app') return captureAppWindow({ redact: red, dict: d });
  const prepared = await prepareSocialMessage(dated, { mirror: true, redact: red ? { dict: d, format: 'image' } : null });
  return renderMessageToCanvas({
    message: prepared.message,
    bodyHtml: prepared.body,
    redactStyle: red ? 'blur' : undefined,
    onCloneNode: red ? (clone) => { redactTree(clone, d); } : undefined,
  });
}

const toBase64 = (canvas) => {
  const url = canvas.toDataURL('image/png');
  return url.slice(url.indexOf(',') + 1);
};

/**
 * `options = { content: 'card'|'app', size: keyof SIZE_PRESETS, background,
 * padding, radius, shadow, chrome, redact }`.
 */
export async function buildSocialExport({ message, options }) {
  if (!hasPremiumAccess(useSettingsStore.getState().billingProfile)) return { ok: false, reason: 'premium' };
  const dated = { ...message, date: asDate(message.date) };
  const redact = mustRedact(options.redact);
  try {
    const dict = redact ? await socialDictionary(dated) : null;
    const content = await buildSocialContent(dated, { content: options.content, redact, dict });
    const canvas = composeSocialImage({
      content,
      size: SIZE_PRESETS[options.size] ?? null,
      background: options.background,
      padding: options.padding,
      radius: options.radius,
      shadow: options.shadow,
      chrome: options.chrome,
      theme: chromeTheme(options.content, useThemeStore.getState().theme),
      fit: options.content === 'app' ? 'contain' : 'crop',
    });
    const named = redact ? redactMessageForExport(dated, dict) : dated;
    const name = singleName(named, 'png').replace(/\.png$/, ' - social.png');
    return { ok: true, file: { name, base64: toBase64(canvas) }, canvas };
  } catch (err) {
    return { ok: false, reason: 'render', error: String(err?.message || err) };
  }
}
