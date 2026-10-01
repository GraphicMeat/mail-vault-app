// ── fontService — Google Fonts on demand, the app's half ──
//
// The daemon downloads a catalogue family once and keeps it
// (`fonts.download` / `fonts.list` / `fonts.read` / `fonts.remove`,
// src-daemon/src/handlers/fonts.rs). This module asks it, follows its
// `font-download` events into a small store the picker renders, and loads a
// downloaded family into this window with `new FontFace(family, bytes)`: no
// URL reaches the page, so the CSP needs no font host.
//
// Every window has its own copy (each webview has its own document.fonts), and
// so has every mail frame: attachMailFonts registers the families a received
// mail is written in into its frame's own document, downloading a catalogue
// family it does not have yet unless tracker blocking is on.
// Nothing here throws at a caller that did not ask to download: a family that
// cannot load leaves the stack's fallback drawing.

import { create } from 'zustand';
import { listen } from '@tauri-apps/api/event';
import { daemonCall } from './daemonClient';
import { findGoogleFont } from '../utils/googleFonts';
import { fontSourcesOf, mailFontFamilies } from '../utils/mailFonts';

export const FONT_EVENT = 'font-download';
// A download whose outcome event was lost still settles: the list is re-read
// on a reconnect or a lag, and every so often while one is pending.
const POLL_MS = 15_000;

/**
 * installed: families downloaded whole; progress: `{done, total}` per family
 * downloading; errors: the last failure's code per family.
 */
export const useFontStore = create(() => ({ installed: [], progress: {}, errors: {} }));

/** `{state: 'idle' | 'downloading' | 'ready' | 'failed', done?, total?, errorCode?}` */
export function fontStatus(state, family) {
  if (state.progress[family]) return { state: 'downloading', ...state.progress[family] };
  if (state.installed.includes(family)) return { state: 'ready' };
  if (state.errors[family]) return { state: 'failed', errorCode: state.errors[family] };
  return { state: 'idle' };
}

const without = (map, key) => {
  if (!(key in map)) return map;
  const { [key]: _gone, ...rest } = map;
  return rest;
};
const fontError = code => Object.assign(new Error(code), { code });

function markDownloading(family, done = 0, total = 0) {
  useFontStore.setState(s => ({ progress: { ...s.progress, [family]: { done, total } }, errors: without(s.errors, family) }));
}
function markReady(family) {
  useFontStore.setState(s => ({
    installed: s.installed.includes(family) ? s.installed : [...s.installed, family].sort(),
    progress: without(s.progress, family),
    errors: without(s.errors, family),
  }));
}
function markFailed(family, code) {
  useFontStore.setState(s => ({ progress: without(s.progress, family), errors: { ...s.errors, [family]: code } }));
}

// family -> { promise, resolve, reject, answered }
const pending = new Map();
let poll = null;
let listed = null;

function settle(family, error) {
  const entry = pending.get(family);
  if (!entry) return;
  pending.delete(family);
  if (!pending.size) { clearInterval(poll); poll = null; }
  if (error) entry.reject(error);
  else void loadFontFaces(family).finally(() => entry.resolve());
}

function onEvent(payload) {
  const family = payload?.family;
  if (!findGoogleFont(family)) return;
  if (payload.state === 'downloading') markDownloading(family, payload.done || 0, payload.total || 0);
  else if (payload.state === 'ready') {
    markReady(family);
    settle(family);
    // Downloaded in another window, for a font this one draws with.
    if (wanted.has(family)) void loadFontFaces(family);
  }
  else if (payload.state === 'failed') {
    const code = payload.errorCode || 'E_FONT_NETWORK';
    markFailed(family, code);
    settle(family, fontError(code));
  }
}

let wiring = null;
function wire() {
  if (!wiring) {
    wiring = (async () => {
      try {
        await listen(FONT_EVENT, e => onEvent(e.payload));
        await listen('daemon-reconnected', () => { void reconcile(); retryWanted(); });
        await listen('daemon-events-lagged', () => { void reconcile(); });
      } catch { /* no Tauri: nothing to hear */ }
    })();
  }
  return wiring;
}

function applyList(answer) {
  const installed = (answer?.fonts || []).map(font => font.family).filter(findGoogleFont).sort();
  const downloading = (answer?.downloading || []).filter(findGoogleFont);
  useFontStore.setState(s => ({
    installed,
    progress: Object.fromEntries(downloading.map(family => [family, s.progress[family] || { done: 0, total: 0 }])),
  }));
  return { installed, downloading };
}

/** Reads what the daemon holds and is downloading. `null` when it cannot say. */
export async function refreshFonts() {
  void wire();
  try {
    const answer = await daemonCall('fonts.list');
    applyList(answer);
    return answer;
  } catch {
    return null;
  }
}

async function reconcile() {
  if (!pending.size) return;
  let list;
  try { list = applyList(await daemonCall('fonts.list')); } catch { return; }
  for (const [family, entry] of [...pending]) {
    if (list.installed.includes(family)) { markReady(family); settle(family); }
    // The daemon said it was downloading and no longer is, with no outcome
    // heard: it restarted, or the event was lost with a failure.
    else if (entry.answered && !list.downloading.includes(family)) {
      markFailed(family, 'E_FONT_NETWORK');
      settle(family, fontError('E_FONT_NETWORK'));
    }
  }
}

/**
 * Downloads `family` once (the daemon answers at once for one it has) and
 * loads it into this window. Resolves when it is ready; rejects with an
 * Error whose `code` is the daemon's (`E_FONT_OFFLINE`, `E_FONT_NETWORK`, ...).
 */
export async function downloadFont(family) {
  if (!findGoogleFont(family)) throw fontError('E_FONT_UNKNOWN');
  if (pending.has(family)) return pending.get(family).promise;
  await wire();
  if (pending.has(family)) return pending.get(family).promise;
  const entry = { answered: false };
  entry.promise = new Promise((resolve, reject) => Object.assign(entry, { resolve, reject }));
  pending.set(family, entry);
  // One already here answers `ready` at once: no spinner flash for it.
  if (!useFontStore.getState().installed.includes(family)) markDownloading(family);
  if (!poll) poll = setInterval(() => { void reconcile(); }, POLL_MS);

  let answer;
  try {
    answer = await daemonCall('fonts.download', { family });
  } catch {
    answer = { state: 'failed', errorCode: 'E_FONT_NETWORK' };
  }
  if (answer?.state === 'downloading') entry.answered = true;
  else onEvent({ family, state: answer?.state === 'ready' ? 'ready' : 'failed', errorCode: answer?.errorCode });
  return entry.promise;
}

// family -> Promise<FontFace[] | null>; a failure is not kept.
const loaded = new Map();
// Every family this window asked to draw with. One that did not load (the
// daemon not up yet at launch, not downloaded yet) is asked again when the
// daemon connects, and when a download of it finishes.
const wanted = new Set();

function retryWanted() {
  for (const family of wanted) if (!loaded.has(family)) void loadFontFaces(family);
}

const bytesOf = base64 => Uint8Array.from(atob(base64), c => c.charCodeAt(0)).buffer;

// family -> Promise<{data: ArrayBuffer, descriptors}[] | null>: the decoded
// files, shared by this window and every mail frame (a thread of ten frames
// reads and decodes a family once). A failure is not kept.
const decoded = new Map();

function readFaces(family) {
  let read = decoded.get(family);
  if (!read) {
    read = (async () => {
      try {
        const answer = await daemonCall('fonts.read', { family });
        const faces = (answer?.faces || []).map(face => ({
          data: bytesOf(face.data),
          descriptors: { weight: String(face.weight), style: face.style || 'normal', unicodeRange: face.unicodeRange },
        }));
        return faces.length ? faces : null;
      } catch {
        return null;
      }
    })();
    decoded.set(family, read);
    read.then(faces => { if (!faces && decoded.get(family) === read) decoded.delete(family); });
  }
  return read;
}

/**
 * Registers a downloaded family's faces in this window, once. `false` (never
 * a throw) when it is not in the catalogue, not downloaded, or the webview
 * has no FontFace.
 */
export function loadFontFaces(family) {
  if (!findGoogleFont(family) || typeof FontFace !== 'function' || typeof document === 'undefined' || !document.fonts) {
    return Promise.resolve(false);
  }
  wanted.add(family);
  void wire();
  let faces = loaded.get(family);
  if (!faces) {
    faces = readFaces(family).then(read => {
      if (!read) return null;
      const made = read.map(face => new FontFace(family, face.data, face.descriptors));
      made.forEach(face => document.fonts.add(face));
      return made;
    }).catch(() => null);
    loaded.set(family, faces);
    faces.then(made => { if (!made) loaded.delete(family); });
  }
  return faces.then(made => !!made);
}

// The daemon's list, read once. A failed read (the daemon not up yet) is
// asked again next time rather than kept as "nothing installed".
function listOnce() {
  if (!listed) {
    const read = refreshFonts();
    listed = read;
    read.then(answer => { if (!answer && listed === read) listed = null; });
  }
  return listed;
}

// The first family a style names: the one the author chose.
const STYLE_FAMILY = /font-family\s*:\s*(?:&quot;|&#39;|["'])?([^,;"'&]+)/gi;

/** Loads every downloaded catalogue family a piece of HTML is drawn in. */
export async function loadFontFacesForHtml(html) {
  if (typeof html !== 'string' || !html.includes('font-family')) return;
  const families = [...new Set([...html.matchAll(STYLE_FAMILY)].map(m => m[1].trim()))].filter(findGoogleFont);
  if (!families.length) return;
  await listOnce();
  const { installed } = useFontStore.getState();
  await Promise.all(families.filter(family => installed.includes(family)).map(loadFontFaces));
}

/** Deletes a downloaded family, and its faces from this window. */
export async function removeFont(family) {
  if (!findGoogleFont(family)) return false;
  let answer;
  try {
    answer = await daemonCall('fonts.remove', { family });
  } catch {
    return false;
  }
  if (answer?.errorCode) return false;
  const faces = await loaded.get(family);
  loaded.delete(family);
  decoded.delete(family);
  faces?.forEach(face => document.fonts.delete(face));
  wanted.delete(family);
  useFontStore.setState(s => ({ installed: s.installed.filter(f => f !== family), errors: without(s.errors, family) }));
  return true;
}

// Families a mail asked for whose download failed this session: asked once,
// so a font that cannot be fetched is not fetched again on every open. Offline
// is not a failure of the font; it is asked again.
const mailFailed = new Set();

async function familyForMail(family, blocking) {
  if (useFontStore.getState().installed.includes(family)) return true;
  if (blocking() || mailFailed.has(family)) return false;
  try {
    await downloadFont(family);
    return true;
  } catch (e) {
    if (e?.code !== 'E_FONT_OFFLINE') mailFailed.add(family);
    return false;
  }
}

async function drawMailFonts(iframe, doc, blocking, onFonts) {
  try {
    const view = doc.defaultView;
    if (typeof view?.FontFace !== 'function' || !doc.fonts) return;
    const families = mailFontFamilies(...fontSourcesOf(doc));
    if (!families.length) return;
    await listOnce();
    const added = await Promise.all(families.map(async family => {
      if (!(await familyForMail(family, blocking))) return [];
      const read = await readFaces(family);
      // The srcDoc may have been replaced (or the frame removed) meanwhile.
      if (!read || iframe.contentDocument !== doc) return [];
      const faces = read.map(face => new view.FontFace(family, face.data, face.descriptors));
      faces.forEach(face => doc.fonts.add(face));
      return faces;
    }));
    const faces = added.flat();
    if (!faces.length || !onFonts) return;
    await Promise.all(faces.map(face => Promise.resolve(face.loaded).catch(() => null)));
    if (iframe.contentDocument === doc) onFonts();
  } catch { /* the stack's fallback draws */ }
}

/**
 * Draws a mail frame in the Google Fonts its mail chose: on every document the
 * frame loads (and the one it shows now), the catalogue families its rendered
 * styles name first are registered into that document's own fonts, downloaded
 * by the daemon first unless `blocking()` is true. `onFonts` runs once a
 * document's faces are in (text metrics changed). Returns a detach function.
 * All after load: opening a message never waits for a font.
 */
export function attachMailFonts(iframe, { blocking = () => false, onFonts } = {}) {
  if (!iframe) return () => {};
  const seen = new WeakSet();
  const run = () => {
    let doc;
    try { doc = iframe.contentDocument; } catch { return; }
    if (!doc || seen.has(doc) || doc.readyState === 'loading') return;
    seen.add(doc);
    void drawMailFonts(iframe, doc, blocking, onFonts);
  };
  iframe.addEventListener('load', run);
  run();
  return () => iframe.removeEventListener('load', run);
}
