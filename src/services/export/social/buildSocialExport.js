import { hasPremiumAccess, useSettingsStore } from '../../../stores/settingsStore';
import { usePrivacyStore } from '../../../stores/privacyStore';
import { useThemeStore } from '../../../stores/themeStore';
import { ensurePrivacyDictionary, collectPrivacyNames } from '../../../utils/privacy/privacyDictionary';
import { buildNameDictionary, unionDictionaries } from '../../../utils/privacy/piiDetector';
import { redactTree } from '../../../utils/privacy/redactDom';
import { prepareSocialMessage } from '../exportService';
import { redactMessageForExport } from '../exportRedact';
import { singleName } from '../exportNaming';
import { trace } from '../exportTrace';
import { captureAppWindow } from './captureAppWindow';
import { renderSocialCard } from './renderSocialCard';
import { composeSocialImage } from './composeSocialImage';
import { loadWatermark } from './socialWatermark';
import { SIZE_PRESETS } from './socialLayout';

const asDate = (value) => (value instanceof Date ? value : new Date(value));

// The host's dictionary (built without masking the UI), plus the message's
// own parties, which a cold host may not know yet.
async function socialDictionary(message) {
  const host = await ensurePrivacyDictionary();
  return unionDictionaries(host, buildNameDictionary({ names: collectPrivacyNames({ emails: [message] }) }));
}

// The window frame (card background and title bar) follows the Appearance
// theme, for the card and the app window alike.
export const chromeTheme = (_content, appTheme) => (appTheme === 'dark' ? 'dark' : 'light');

// Privacy mode on means redacted, whatever the checkbox says.
const mustRedact = (redact) => !!redact || usePrivacyStore.getState().enabled;

/**
 * The content canvas alone (card render or app capture, redacted when asked).
 * The panel caches it per (content, redact, themes) and re-composes on style
 * changes. `dict` skips a second dictionary wait when the caller has one.
 * `theme` is the Appearance (the app window's theme, the card's header block);
 * `mailTheme` is the card's mail body, following `theme` when absent.
 */
export async function buildSocialContent(message, { content, redact, dict, theme, mailTheme } = {}) {
  const dated = { ...message, date: asDate(message.date) };
  const red = mustRedact(redact);
  const d = red ? (dict ?? await socialDictionary(dated)) : null;
  if (content === 'app') return captureAppWindow({ redact: red, dict: d, theme });
  const prepared = await prepareSocialMessage(dated, { mirror: true, redact: red ? { dict: d, format: 'image' } : null });
  return renderSocialCard({
    message: prepared.message,
    bodyHtml: prepared.body,
    appearance: theme === 'dark' ? 'dark' : 'light',
    mail: (mailTheme ?? theme) === 'dark' ? 'dark' : 'light',
    palette: useThemeStore.getState().palette,
    redactStyle: red ? 'blur' : undefined,
    onCloneNode: red ? (clone) => { redactTree(clone, d); } : undefined,
  });
}

// Async end to end: toDataURL encodes the whole PNG on the main thread, and a
// story-sized card is 2160x3840 of it.
const toBase64 = (canvas) => new Promise((resolve, reject) => {
  const t0 = performance.now();
  canvas.toBlob((blob) => {
    if (!blob) { reject(new Error('PNG encode produced no data')); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      trace('social-encode-total', { ms: Math.round(performance.now() - t0), bytes: blob.size });
      resolve(url.slice(url.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error || new Error('PNG read failed'));
    reader.readAsDataURL(blob);
  }, 'image/png');
  trace('social-encode-call', { ms: Math.round(performance.now() - t0) });
});

/**
 * `options = { content: 'card'|'app', size: keyof SIZE_PRESETS, background,
 * padding, radius, shadow, chrome, redact, appTheme, mailTheme }`.
 * `appTheme` ('light' | 'dark', null follows the app) is the Appearance: the
 * app window's theme and the card's frame and header. `mailTheme` is the card's
 * mail body, null follows the Appearance.
 */
export async function buildSocialExport({ message, options }) {
  if (!hasPremiumAccess(useSettingsStore.getState().billingProfile)) return { ok: false, reason: 'premium' };
  const dated = { ...message, date: asDate(message.date) };
  const redact = mustRedact(options.redact);
  try {
    const theme = options.appTheme ?? useThemeStore.getState().theme;
    const dict = redact ? await socialDictionary(dated) : null;
    let t = performance.now();
    const lap = (step) => { const now = performance.now(); trace(step, { ms: Math.round(now - t) }); t = now; };
    const content = await buildSocialContent(dated, { content: options.content, redact, dict, theme, mailTheme: options.mailTheme ?? theme });
    lap('social-content');
    const watermark = await loadWatermark();
    t = performance.now();
    const canvas = composeSocialImage({
      content,
      size: SIZE_PRESETS[options.size] ?? null,
      background: options.background,
      padding: options.padding,
      radius: options.radius,
      shadow: options.shadow,
      chrome: options.chrome,
      theme: chromeTheme(options.content, theme),
      watermark,
    });
    lap('social-compose');
    const named = redact ? redactMessageForExport(dated, dict) : dated;
    const name = singleName(named, 'png').replace(/\.png$/, ' - social.png');
    return { ok: true, file: { name, base64: await toBase64(canvas) }, canvas };
  } catch (err) {
    return { ok: false, reason: 'render', error: String(err?.message || err) };
  }
}
