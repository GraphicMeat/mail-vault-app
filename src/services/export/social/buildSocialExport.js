import { hasPremiumAccess, useSettingsStore } from '../../../stores/settingsStore';
import { usePrivacyStore } from '../../../stores/privacyStore';
import { useThemeStore } from '../../../stores/themeStore';
import { ensurePrivacyDictionary, collectPrivacyNames } from '../../../utils/privacy/privacyDictionary';
import { buildNameDictionary, unionDictionaries } from '../../../utils/privacy/piiDetector';
import { redactTree } from '../../../utils/privacy/redactDom';
import { prepareSocialMessage } from '../exportService';
import { redactMessageForExport } from '../exportRedact';
import { addressLine } from '../exportDocument';
import { singleName } from '../exportNaming';
import { useMailStore } from '../../../stores/mailStore';
import { buildRevealSet, revealAddressesOnly } from './revealSender';
import { senderDetailsHtml } from './senderDetails';
import { socialLinksHtml } from './socialLinks';
import { captureTargetOf } from '../../../utils/captureTarget';
import { trace } from '../exportTrace';
import { captureAppWindow } from './captureAppWindow';
import { renderSocialCard } from './renderSocialCard';
import { composeSocialImage } from './composeSocialImage';
import { loadWatermark } from './socialWatermark';
import { canvasToPngBase64 } from './encodePng';
import { SIZE_PRESETS } from './socialLayout';

const asDate = (value) => (value instanceof Date ? value : new Date(value));

// The host's dictionary (built without masking the UI), plus the message's
// own parties, which a cold host may not know yet.
async function socialDictionary(message) {
  const host = await ensurePrivacyDictionary();
  return unionDictionaries(host, buildNameDictionary({ names: collectPrivacyNames({ emails: [message] }) }));
}

// The dictionary with the spam sender's exact values to leave readable, when the
// image is redacted and asked for it. A copy: the host's dictionary is shared.
function dictionaryWithReveal(dict, message, { redact, revealSender }) {
  if (!redact || !revealSender || !dict || dict.reveal?.size) return dict;
  const mail = useMailStore.getState();
  const settings = useSettingsStore.getState();
  const reveal = buildRevealSet(message, {
    accounts: mail.accounts, sendAsAddresses: settings.sendAsAddresses, aliases: settings.aliases, displayNames: settings.displayNames,
  });
  return reveal.size ? { ...dict, reveal } : dict;
}

// The sender-details and links boxes are masked as they are built (their values
// through the dictionary, their labels are ours): the header's safety-net pass
// skips them, or a label sharing a name token ("Sender Details" beside a contact
// called Sender) comes out as filler. Set aside, the rest redacted, put back.
function redactOutsideBoxes(clone, dict, hooks) {
  const boxes = [...(clone.querySelectorAll?.('[data-mv-box]') || [])].map((box) => {
    const mark = box.ownerDocument.createComment('');
    box.replaceWith(mark);
    return [mark, box];
  });
  redactTree(clone, dict, hooks);
  for (const [mark, box] of boxes) mark.replaceWith(box);
}

// The window frame (card background and title bar) follows the Appearance
// theme, for the card and the app window alike.
export const chromeTheme = (_content, appTheme) => (appTheme === 'dark' ? 'dark' : 'light');

// Privacy mode on means redacted, whatever the checkbox says.
const mustRedact = (redact) => !!redact || usePrivacyStore.getState().enabled;

/**
 * The content canvas alone (card render or app capture, redacted when asked).
 * The panel caches it per (content, redact, themes, reveal, details, links) and
 * re-composes on style changes. `dict` skips a second dictionary wait when the
 * caller has one. `theme` is the Appearance (the app window's theme, the card's
 * header block); `mailTheme` is the card's mail body, following `theme` when
 * absent. `revealSender` (redacted only) leaves a spam sender's exact name and
 * addresses readable; `senderDetails` adds the sender-details box (the open
 * message's real popover, in the app window); `links` adds the links list
 * (card only).
 */
export async function buildSocialContent(message, { content, redact, dict, theme, mailTheme, revealSender, senderDetails, links } = {}) {
  const dated = { ...message, date: asDate(message.date) };
  const red = mustRedact(redact);
  const d = red ? dictionaryWithReveal(dict ?? await socialDictionary(dated), dated, { redact: red, revealSender }) : null;
  if (content === 'app') {
    // Addresses only: a name revealed in the live UI unmasks every row that names
    // it, and a spoofed display name can be a real contact's.
    const reveal = revealAddressesOnly(d?.reveal);
    return captureAppWindow({
      redact: red, dict: d && d.reveal ? { ...d, reveal } : d, theme, reveal,
      // The open message's header opens its own popover; named as the reader places it.
      senderDetails: senderDetails ? captureTargetOf(dated, useMailStore.getState()) ?? undefined : undefined,
    });
  }
  const prepared = await prepareSocialMessage(dated, {
    mirror: true, redact: red ? { dict: d, format: 'image' } : null, details: !!senderDetails, links: !!links,
  });
  const extrasHtml = [
    prepared.details && senderDetailsHtml(prepared.details),
    prepared.links && socialLinksHtml(prepared.links),
  ].filter(Boolean).join('');
  // A revealed name sits in a header text node of its own (and inside the From
  // line); the safety-net pass over the header keeps exactly those, never body text.
  const keep = red && d.reveal?.size
    ? new Set([...d.reveal, addressLine(prepared.message.from).toLowerCase()])
    : null;
  return renderSocialCard({
    message: prepared.message,
    bodyHtml: prepared.body,
    appearance: theme === 'dark' ? 'dark' : 'light',
    mail: (mailTheme ?? theme) === 'dark' ? 'dark' : 'light',
    palette: useThemeStore.getState().palette,
    redactStyle: red ? 'blur' : undefined,
    extrasHtml: extrasHtml || undefined,
    onCloneNode: red ? (clone) => { redactTree(clone, d); } : undefined,
    onCloneHead: red
      ? (clone) => redactOutsideBoxes(clone, d, keep ? { keep: (text) => keep.has(String(text).trim().toLowerCase()) } : {})
      : undefined,
  });
}

// The full-size image from a content canvas and the panel's style.
const composeFull = (content, options, theme, watermark) => composeSocialImage({
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

const socialName = (message) => singleName(message, 'png').replace(/\.png$/, ' - social.png');

/**
 * The file name Save offers, masked like the image. Built where the content is
 * (the main window), for a detached panel that saves on its own.
 */
export async function socialFileName(message, { redact, revealSender } = {}) {
  const dated = { ...message, date: asDate(message.date) };
  const red = mustRedact(redact);
  if (!red) return socialName(dated);
  const dict = dictionaryWithReveal(await socialDictionary(dated), dated, { redact: red, revealSender });
  return socialName(redactMessageForExport(dated, dict));
}

/**
 * Save in a detached panel: the content arrived from the main window already
 * rendered (and redacted there), so only the style is applied here, an own
 * image background included. Same shape as buildSocialExport's result.
 */
export async function composeSocialFile({ content, options, name }) {
  if (!hasPremiumAccess(useSettingsStore.getState().billingProfile)) return { ok: false, reason: 'premium' };
  try {
    const theme = options.appTheme ?? useThemeStore.getState().theme;
    const canvas = composeFull(content, options, theme, await loadWatermark());
    return { ok: true, file: { name, base64: await canvasToPngBase64(canvas) }, canvas };
  } catch (err) {
    return { ok: false, reason: 'render', error: String(err?.message || err) };
  }
}

/**
 * `options = { content: 'card'|'app', size: keyof SIZE_PRESETS, background,
 * padding, radius, shadow, chrome, redact, appTheme, mailTheme, revealSender,
 * senderDetails, links }`.
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
    const dict = redact ? dictionaryWithReveal(await socialDictionary(dated), dated, { redact, revealSender: options.revealSender }) : null;
    let t = performance.now();
    const lap = (step) => { const now = performance.now(); trace(step, { ms: Math.round(now - t) }); t = now; };
    const content = await buildSocialContent(dated, {
      content: options.content, redact, dict, theme, mailTheme: options.mailTheme ?? theme,
      revealSender: options.revealSender, senderDetails: options.senderDetails, links: options.links,
    });
    lap('social-content');
    const watermark = await loadWatermark();
    t = performance.now();
    const canvas = composeFull(content, options, theme, watermark);
    lap('social-compose');
    const name = socialName(redact ? redactMessageForExport(dated, dict) : dated);
    return { ok: true, file: { name, base64: await canvasToPngBase64(canvas) }, canvas };
  } catch (err) {
    return { ok: false, reason: 'render', error: String(err?.message || err) };
  }
}

// The connected e2e spec composes a full image (card, background, lockup) through this.
if (import.meta.env.VITE_E2E === '1' && typeof window !== 'undefined') {
  window.__MV_SOCIAL_COMPOSE__ = { composeSocialImage, loadWatermark, sizes: SIZE_PRESETS };
  // The card with its sender-details and links boxes, from an in-memory message.
  window.__MV_SOCIAL_CONTENT__ = buildSocialContent;
}
