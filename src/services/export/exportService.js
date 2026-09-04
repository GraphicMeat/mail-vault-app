import { hasPremiumAccess, useSettingsStore } from '../../stores/settingsStore';
import { sanitizeForExport } from './exportSanitize';
import { mirrorRemoteAssets, DEFAULT_CAPS } from './mirrorRemoteAssets';
import { renderMessageToCanvas, measureMessageHeight } from './renderMessageToCanvas';
import { planPages, stitchPages } from './imagePacker';
import { buildThreadDocument } from './exportHtml';
import { singleName, threadName, threadMemberName, pageName, attachmentFileName, dedupeNames } from './exportNaming';
import { replaceCidUrls, getRealAttachments, hydrateInlineImages } from '../attachmentUtils';
import { resolveMessageBody } from './bodyResolver';
import { useMailStore } from '../../stores/mailStore';
import { resolveEmailLocation } from '../../stores/slices/unifiedHelpers';
import { getEmailBodyContent } from '../../utils/emailIframeTemplate';
import { trace } from './exportTrace';

// Samples run the real pipeline over fixture data, so they must reach it
// without a subscription. Everything else meets the gate below.
export const SAMPLE = Symbol('sample');

// e2e fault injection. A suite that only ever sees the happy path cannot tell
// an absence-assertion that holds from one that was never reachable, so the
// specs force each failure and check what the app does with it. Compiled out
// of a shipped build.
const E2E = Boolean(import.meta.env?.VITE_E2E);
const forcedFailure = () => (E2E ? (globalThis.window?.__MV_FORCE_EXPORT_FAILURE__ ?? null) : null);

export async function fetchAssetViaTauri(url) {
  const { invoke } = window.__TAURI__.core;
  return invoke('fetch_remote_asset', { url });
}

export async function readAttachmentViaTauri({ accountId, mailbox, uid, attachmentIndex }) {
  const { invoke } = window.__TAURI__.core;
  return invoke('maildir_read_attachment', { accountId, mailbox, uid, attachmentIndex });
}

// Same normalisation the attachment bar does before it hands bytes to Rust: a
// stored `content` may arrive as a whole data: URI, and a Maildir read wraps
// its base64 at 76 columns.
function cleanBase64(content) {
  if (typeof content !== 'string') return content;
  // Whitespace first, unlike the attachment bar's copy: `.` never crosses a
  // newline, so a WRAPPED data: URI misses the prefix match and keeps it.
  const base64 = content.replace(/[\s\n\r]/g, '');
  return base64.startsWith('data:')
    ? (base64.match(/^data:[^;]+;base64,(.+)$/)?.[1] ?? base64)
    : base64;
}

const toBase64 = (canvas) => {
  const url = canvas.toDataURL('image/png');
  return url.slice(url.indexOf(',') + 1);
};

// A stored message carries `date` as a STRING — every reader in the app says
// `new Date(e.date)`. The naming, the header card and the thread document all
// call Date methods on it, and subtracting two strings to sort gives NaN.
const asDate = (value) => (value instanceof Date ? value : new Date(value));

const utf8ToBase64 = (text) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(text)));

// The body a message contributes to an export: CID images resolved, executable
// content stripped, remote content mirrored when the user asked for it.
async function prepareBody(message, mirror, fetchAsset, totals) {
  const raw = getEmailBodyContent(replaceCidUrls(message.html || '', message.attachments));
  const safe = sanitizeForExport(raw);
  if (!mirror) return safe;
  const { html, stats } = await mirrorRemoteAssets(safe, { fetchAsset, caps: DEFAULT_CAPS });
  totals.mirrored += stats.mirrored;
  totals.failed += stats.failed;
  totals.pixelsRemoved += stats.pixelsRemoved;
  totals.bytes += stats.bytes;
  return html;
}

// A row menu and the bulk bar hand over headers, not bodies. Loading one goes
// through the same guarded path the reading pane uses — never a second copy of
// the vault-then-server sequence.
async function hydrate(message) {
  if (message.html) return message;
  const result = await resolveMessageBody(message, useMailStore.getState());
  if (!result.ok) throw new Error(result.reason);
  // The body is merged UNDER the header's date, not over it. The loaded body
  // carries its own `date`, as a string, so a plain spread put the raw string
  // back on top of the coercion below and every name and header card threw
  // "getFullYear is not a function" — but only against real mail, because a
  // fixture that already holds a body never takes this path at all.
  return { ...message, ...result.email, date: asDate(message.date) };
}

/**
 * The bytes of one message's real attachments, named for a filesystem.
 *
 * `location` is resolved from the ORIGINAL header, not from the hydrated copy:
 * the merge in `hydrate` carries no `_mailbox`, and a uid read out of the wrong
 * folder is a real but unrelated file. Unplaceable, or unreadable, means the
 * attachment is named in `failures` — never silently dropped, never guessed at.
 */
async function loadAttachments(location, full, readAttachment, failures) {
  const real = getRealAttachments(full.attachments, full.html);
  if (!real.length) return [];
  const names = dedupeNames(real.map((att, i) => attachmentFileName(att, i)));

  const loaded = [];
  for (const [i, att] of real.entries()) {
    try {
      if (!att.content && !location) throw new Error('unknown mailbox');
      const content = att.content ?? await readAttachment({
        accountId: location.accountId,
        mailbox: location.mailbox,
        uid: full.uid,
        attachmentIndex: att._originalIndex,
      });
      loaded.push({ name: names[i], contentType: att.contentType, base64: cleanBase64(content) });
    } catch (err) {
      trace('attachment-failed', { uid: full.uid, name: names[i] });
      failures.push(names[i]);
    }
  }
  return loaded;
}

// The attachments of every message that made it into one file, deduped under
// that file's name — two messages in one image can both carry an invoice.pdf.
function buildSidecars(items, stemFor) {
  const groups = new Map();
  items.forEach((item, i) => {
    if (!item.attachments.length) return;
    const stem = stemFor(i);
    groups.set(stem, [...(groups.get(stem) || []), ...item.attachments]);
  });
  return [...groups].flatMap(([stem, atts]) =>
    dedupeNames(atts.map(a => a.name)).map((name, i) => ({ stem, name, base64: atts[i].base64 })));
}

const stemOf = (fileName) => fileName.replace(/\.[^.]+$/, '');

export async function buildExport({
  messages, format, layout = 'single', mirror = true, account, mailbox,
  gate, fetchAsset = fetchAssetViaTauri,
  attachments = false, readAttachment = readAttachmentViaTauri,
}) {
  if (gate !== SAMPLE) {
    const { billingProfile } = useSettingsStore.getState();
    if (!hasPremiumAccess(billingProfile)) return { ok: false, reason: 'premium', files: [], failures: [] };
  }

  if (forcedFailure() === 'render') return { ok: false, reason: 'render', files: [], failures: [] };
  const forceMirrorFailure = forcedFailure() === 'mirror';

  const stats = { mirrored: 0, failed: 0, pixelsRemoved: 0, bytes: 0 };
  const ordered = [...messages]
    .map(m => (m.date instanceof Date ? m : { ...m, date: asDate(m.date) }))
    .sort((a, b) => a.date - b.date);
  const failures = [];
  const attachmentFailures = [];
  const prepared = [];
  trace('start', { format, layout, mirror, messages: ordered.length });

  for (const message of ordered) {
    try {
      trace('hydrate', { uid: message.uid });
      // Resolved from the header the caller handed over, before hydrate merges
      // a body over it and the `_mailbox` tag is gone.
      const location = resolveEmailLocation(message, useMailStore.getState());
      // A cid: image whose bytes the light path stripped stays a cid: URL in the
      // exported file — a reference nothing outside this app can resolve, and
      // one the rasterizer's frame then waits on. Same fill the reader does.
      const full = await hydrateInlineImages(await hydrate(message), location?.accountId, location?.mailbox);
      const fetcher = forceMirrorFailure
        ? async () => { throw new Error('forced mirror failure'); }
        : fetchAsset;
      prepared.push({
        message: full,
        body: await prepareBody(full, mirror, fetcher, stats),
        attachments: attachments ? await loadAttachments(location, full, readAttachment, attachmentFailures) : [],
      });
      trace('prepared', { uid: message.uid });
    } catch (err) {
      // One body that will not load is not a failed export of the other forty.
      failures.push({ uid: message.uid, subject: message.subject, error: String(err.message || err) });
    }
  }

  if (!prepared.length) return { ok: false, reason: 'body', files: [], failures, stats };

  const ext = format === 'html' ? 'html' : 'png';
  const base = prepared.length === 1
    ? singleName(prepared[0].message, ext)
    : threadName(prepared.map(p => p.message), ext);

  if (format === 'html') {
    const heights = [];
    for (const item of prepared) {
      heights.push(await measureMessageHeight({ message: item.message, bodyHtml: item.body }));
    }
    const html = buildThreadDocument({
      messages: prepared.map(p => p.message),
      bodies: prepared.map(p => p.body),
      attachments: prepared.map(p => p.attachments),
      heights, account, mailbox, stats,
    });
    // Embedded as download links in the document itself — nothing beside it.
    return {
      ok: true, partial: failures.length > 0, failures, attachmentFailures, stats,
      files: [{ name: base, base64: utf8ToBase64(html) }], sidecars: [],
    };
  }

  const canvases = [];
  const rendered = [];
  for (const item of prepared) {
    try {
      trace('render', { uid: item.message.uid });
      canvases.push(await renderMessageToCanvas({
        message: item.message, bodyHtml: item.body, account, mailbox, stats,
      }));
      rendered.push(item);
      trace('rendered', { uid: item.message.uid });
    } catch (err) {
      failures.push({ uid: item.message.uid, subject: item.message.subject, error: String(err.message || err) });
    }
  }

  if (!canvases.length) return { ok: false, reason: 'render', files: [], failures, stats };

  let files;
  if (layout === 'separate') {
    files = canvases.map((canvas, i) => ({
      name: rendered.length === 1
        ? singleName(rendered[0].message, ext)
        : threadMemberName(rendered[i].message, i, ext),
      base64: toBase64(canvas),
    }));
  } else {
    const plan = planPages(canvases.map(c => ({ width: c.width, height: c.height })));
    const pages = stitchPages(canvases, plan);
    files = pages.map((canvas, i) => ({
      name: pageName(base, i + 1, pages.length),
      base64: toBase64(canvas),
    }));
  }

  // Separate images: each message's attachments belong to ITS file. One tall
  // image: they belong to the thread, not to whichever page it was cut into.
  const sidecars = buildSidecars(rendered, i => stemOf(layout === 'separate' ? files[i].name : base));

  trace('files', { n: files.length, sidecars: sidecars.length });
  return { ok: true, partial: failures.length > 0, failures, attachmentFailures, stats, files, sidecars };
}
