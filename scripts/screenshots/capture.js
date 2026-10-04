/**
 * Native window capture for marketing screenshots.
 *
 * `screencapture -l <windowid>` grabs the real app window — rounded corners,
 * traffic lights, transparent surround — at the display's backing scale. On a
 * HiDPI screen that is 2x, which is the whole reason these run on the Mac mini
 * with the 5K panel rather than in a headless browser.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';

const HERE = import.meta.dirname;
const SWIFT_SRC = join(HERE, 'windowid.swift');
const SWIFT_BIN = join(HERE, '.windowid');

/**
 * English writes `website/screenshots/`; every other locale writes its own
 * subdirectory beside it, which is exactly where the website generator looks
 * for a localized shot before falling back to the English file.
 */
const LOCALE_DIR = process.env.SHOTS_LOCALE || 'en';

/**
 * Dark keeps the plain base name — every page on the site already points at it,
 * and the app has shipped a dark default since the first capture. Light writes
 * a `-light` sibling in the SAME directory rather than a `light/` subtree:
 * `i18n.mjs`'s `localizeShot` only matches `/screenshots/<one-segment>`, so a
 * nested path would silently stop being localized and every locale would serve
 * the English light shot.
 */
export const THEME_SUFFIX = process.env.SHOTS_THEME === 'light' ? '-light' : '';

const IS_LINUX = process.platform === 'linux';

export const OUT_DIR = process.env.SHOTS_OUT
  || resolve(HERE, '../../website/screenshots', LOCALE_DIR === 'en' ? '' : LOCALE_DIR);

/** Compile the window-id helper, and again whenever its source moves ahead of
 *  it — a cached binary from before an edit is a wrong window nobody sees. */
function windowIdBinary() {
  if (!existsSync(SWIFT_BIN) || statSync(SWIFT_SRC).mtimeMs > statSync(SWIFT_BIN).mtimeMs) {
    execFileSync('swiftc', ['-O', SWIFT_SRC, '-o', SWIFT_BIN], { stdio: 'inherit' });
  }
  return SWIFT_BIN;
}

/**
 * The pid of the app this run launched, or null.
 *
 * A MailVault the user already has open answers to the same owner name, and
 * windowid takes the largest match — so on a machine with the real app running,
 * the run photographs someone's actual mailbox and says nothing about it. The
 * conf publishes the binary path it launched; the window is pinned to whatever
 * process is running exactly that.
 */
function appPid() {
  const binary = process.env.SHOTS_APP_BINARY;
  if (!binary) return null;
  try {
    const pids = execFileSync('pgrep', ['-f', binary], { encoding: 'utf-8' })
      .trim().split('\n').filter(Boolean);
    // `pgrep -f <binary>` matches `<binary>-daemon` too, and the daemon can
    // outlive a killed run — an orphan from 11:35 then sorts ahead of the app
    // this run launched, pins MAILVAULT_WINDOW_PID to a process that owns no
    // window, and every locale skips with "no capturable window owned by
    // MailVault; candidates:" and an empty list. Keep only a process whose
    // argv[0] IS the binary.
    const apps = pids.filter((pid) => execFileSync('ps', ['-o', 'command=', '-p', pid], { encoding: 'utf-8' })
      .trim().split(' ')[0] === binary);
    // tauri-wd gives an app 30s to report its plugin port, then fails the
    // session WITHOUT killing it, and wdio's retry launches another. On Linux
    // a slow start did exactly that: four apps on one display, and the first
    // one — never driven — was photographed for every shot.
    if (IS_LINUX && apps.length > 1) {
      throw new MultipleAppsError(`${apps.length} instances of ${binary} are running (${apps.join(', ')}): `
        + 'a session retry left the earlier ones behind, and the one being driven cannot be told apart');
    }
    return apps[0] ?? null;
  } catch (e) {
    if (e instanceof MultipleAppsError) throw e;
    return null; // not up yet — windowId retries, and fails loudly if it never is
  }
}

class MultipleAppsError extends Error {}

/**
 * CGWindowID of the app's main window. Retried: a window being moved, resized
 * or raised is briefly absent from the on-screen list, and one miss there would
 * cost a screenshot.
 */
export function windowId(appName = 'MailVault', attempts = 4) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      const pid = appPid();
      return execFileSync(windowIdBinary(), [appName], {
        encoding: 'utf-8',
        env: pid ? { ...process.env, MAILVAULT_WINDOW_PID: pid } : process.env,
      }).trim();
    } catch (e) {
      lastError = e;
      execFileSync('sleep', ['0.5']);
    }
  }
  throw lastError;
}

/**
 * Capture the app window to `<OUT_DIR>/<name>.png`.
 * `-o` drops the drop shadow, matching the existing screenshot set.
 */
/**
 * The byte size of the previous capture. Two DIFFERENT screens cannot produce
 * byte-identical PNGs — when they do, the window is not being composited and
 * `screencapture -l` is writing the same empty frame for every shot.
 *
 * It reports success either way, so nothing upstream notices: a whole sweep
 * says "50 captured, 0 skipped" per locale and lands thousands of identical
 * blank files. That has happened twice; the causes differ (the session showing
 * `loginwindow`, a window on a Space that is not being drawn) and the tell is
 * always the same, so check the tell rather than the cause.
 */
let previousBytes = 0;

/**
 * X11 id of the app's top-level window, found by the pid capture pins to.
 * `--onlyvisible` drops GTK's hidden helper windows; the largest of what is
 * left is the main window, the same rule windowid.swift applies on macOS.
 */
function x11WindowId(attempts = 10) {
  for (let i = 0; i < attempts; i++) {
    const pid = appPid();
    if (pid) {
      let ids = [];
      try {
        ids = execFileSync('xdotool', ['search', '--onlyvisible', '--pid', pid], { encoding: 'utf-8' })
          .trim().split('\n').filter(Boolean);
      } catch { /* none mapped yet */ }
      const sized = ids.map((id) => {
        const geo = execFileSync('xdotool', ['getwindowgeometry', '--shell', id], { encoding: 'utf-8' });
        const w = Number(geo.match(/WIDTH=(\d+)/)?.[1]);
        const h = Number(geo.match(/HEIGHT=(\d+)/)?.[1]);
        return { id, area: w * h };
      }).sort((a, b) => b.area - a.area);
      if (sized[0]?.area) return sized[0].id;
    }
    execFileSync('sleep', ['0.5']);
  }
  throw new Error(`no visible X11 window owned by ${process.env.SHOTS_APP_BINARY}`);
}

/**
 * Linux capture: the app window itself. The app runs with GTK_CSD=1
 * (run-linux.sh), so the Yaru titlebar GTK draws is part of that window, the
 * same titlebar an Ubuntu (Wayland) session shows. No compositor runs under
 * Xvfb, so GTK's shadow margin around the window and the area outside its
 * rounded top corners come out pure black: flood-fill that from the four
 * corners to transparent, then trim it off.
 */
function captureLinux(out) {
  execFileSync('import', ['-silent', '-window', x11WindowId(), out]);
  const { width, height } = pngSize(out);
  const [r, b] = [width - 1, height - 1];
  execFileSync('convert', [out, '-alpha', 'set', '-fill', 'none', '-fuzz', '0%',
    ...[[0, 0], [r, 0], [0, b], [r, b]].flatMap(([x, y]) => ['-draw', `color ${x},${y} floodfill`]),
    '-trim', '+repage', out]);
}

export function capture(name, { appName = 'MailVault' } = {}) {
  const out = join(OUT_DIR, `${name}${THEME_SUFFIX}.png`);
  mkdirSync(dirname(out), { recursive: true });
  if (IS_LINUX) captureLinux(out);
  else execFileSync('screencapture', ['-x', '-o', '-t', 'png', '-l', windowId(appName), out]);
  const bytes = statSync(out).size;
  if (bytes === previousBytes) {
    throw new Error(`blank capture: ${name} is byte-identical to the previous shot (${bytes} B) — `
      + 'the window is not being composited. Check `lsappinfo front`: a session showing '
      + '`loginwindow` renders app windows to nothing, and screencapture still exits 0.');
  }
  previousBytes = bytes;
  console.log(`[shot] ${out}`);
  return out;
}

/** Pixel dimensions of a PNG on disk, via `sips` — no new dependency. */
export function pngSize(path) {
  if (IS_LINUX) {
    const [width, height] = execFileSync('identify', ['-format', '%w %h', path], { encoding: 'utf-8' })
      .trim().split(' ').map(Number);
    return { width, height };
  }
  const out = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', path], { encoding: 'utf-8' });
  const width = Number(out.match(/pixelWidth:\s*(\d+)/)?.[1]);
  const height = Number(out.match(/pixelHeight:\s*(\d+)/)?.[1]);
  if (!width || !height) throw new Error(`sips could not read the size of ${path}`);
  return { width, height };
}

/**
 * Map an element's CSS-pixel rect inside the webview to a pixel crop box in
 * the window's PNG capture — pure, no I/O, so `detailCrop.check.mjs` can
 * assert it directly.
 *
 * The webview sits bottom-aligned and horizontally centred inside the native
 * window screenshot: the title bar/frame is the strip above it, and
 * `screencapture -o` (no drop shadow) leaves no border on the other three
 * sides. So, in image pixels:
 *
 *   offsetX = (imgW - innerWidth  * dpr) / 2   — centred horizontally
 *   offsetY =  imgH - innerHeight * dpr        — flush with the bottom
 *
 * `rect` is CSS px from `getBoundingClientRect()`; `padding` is CSS px added
 * on every side before scaling to device pixels. The result is clamped to the
 * image bounds — `sips --cropOffset` does not clamp, it pads whatever is
 * outside the source with black — and returns null when the padded rect has
 * no on-screen overlap with the image at all (offscreen element, stale rect,
 * wrong selector). Callers must treat null as "skip", never as a 0×0 crop.
 */
export function detailCropBox(rect, viewport, image, padding = 0) {
  const { innerWidth, innerHeight, devicePixelRatio: dpr } = viewport;
  const offsetX = (image.width - innerWidth * dpr) / 2;
  const offsetY = image.height - innerHeight * dpr;

  const left = offsetX + (rect.x - padding) * dpr;
  const top = offsetY + (rect.y - padding) * dpr;
  const width = (rect.width + 2 * padding) * dpr;
  const height = (rect.height + 2 * padding) * dpr;

  const x0 = Math.max(0, left);
  const y0 = Math.max(0, top);
  const x1 = Math.min(image.width, left + width);
  const y1 = Math.min(image.height, top + height);

  const outW = Math.round(x1 - x0);
  const outH = Math.round(y1 - y0);
  if (outW <= 0 || outH <= 0) return null;

  return { x: Math.round(x0), y: Math.round(y0), width: outW, height: outH };
}

/**
 * Crop `srcPng` to `box` (from `detailCropBox`) and write `outPng`, via
 * `sips --cropToHeightWidth H W --cropOffset Y X` — order verified empirically
 * (macOS ships no man-page example): `--cropOffset` takes an ABSOLUTE
 * top-left corner as `<fromTop> <fromLeft>`, not an offset from the sips
 * default centred crop, and `--out` leaves the source file untouched.
 */
export function cropDetail(srcPng, outPng, box) {
  if (IS_LINUX) {
    execFileSync('convert', [srcPng, '-crop', `${box.width}x${box.height}+${box.x}+${box.y}`, '+repage', outPng]);
    return;
  }
  execFileSync('sips', [
    '--cropToHeightWidth', String(box.height), String(box.width),
    '--cropOffset', String(box.y), String(box.x),
    srcPng, '--out', outPng,
  ], { stdio: 'ignore' });
}
