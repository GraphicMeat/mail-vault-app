// Perf-gate builds only (App.jsx runs it when the engine's ping says `perfGate`): the scripted
// viewer behind `?ui=viewer`. Query, all optional beyond `ui=viewer`:
//   row=N               the row to leave open (default 0); screenshots stop here
//   measureRows=A,B     first open each of these rows for 6 s and log
//                       `{"viewerMeasure":{row, bytes, prepareMs, headerMs, bodyMs}}` (ms from the
//                       open: header painted, the frame's document loaded)
//   loadImagesAfter=S   S s after row N opened, log `{"viewerProbe":"tap","at":<Date.now()>}` and
//                       tap Load images, then wait 12 s
//   controlPorts=A-B    then log `{"viewerProbe":"controls","at"}` and load an https image from
//                       every port A..B on 127.0.0.1 and 10.0.2.2 from the app page itself: the
//                       positive control that the device reaches each port of a request logger
//   attach=A[,B...]     then, 3 s apart, act on the open message's attachments and links (the
//                       iOS simulator has no tap tool): `open` taps the first ready chip, `share`
//                       long-presses it, `fetch` taps the first idle chip, `link` sends the app page
//                       itself to https://example.com/ (the shell must cancel it and open the
//                       browser; a link inside the sandboxed frame cannot be scripted). Logs
//                       `{"viewerProbe":"attach","action","found"}` per action, and
//                       `{"viewerProbe":"visible","path","viewer"}` whenever the page comes back
//                       to the foreground (the app stayed put after a link)
//   holdAfter=S         wait S s before `done` (default 6 with `attach`), so the previewer, sheet
//                       or browser is on screen for a screenshot
// Ends with `{"viewerProbe":"done"}`.
import { resetViewerTimings, viewerTimings } from './perf.js';

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const HOSTS = ['127.0.0.1', '10.0.2.2'];

function parseRows(value) {
  return String(value || '').split(',').map((v) => Number(v)).filter((n) => Number.isInteger(n) && n >= 0);
}

function parsePorts(value) {
  const m = /^(\d{2,5})-(\d{2,5})$/.exec(String(value || ''));
  if (!m) return [];
  const [from, to] = [Number(m[1]), Number(m[2])];
  if (to < from || to - from > 100) return [];
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

const ms = (at, t0) => (at == null ? null : Math.round(at - t0));

/** One scripted `attach=` action on the open viewer; whether its target was there. */
async function attachAction(action) {
  const chip = (state) => document.querySelector(`[data-mv-attachment-state="${state}"]`);
  if (action === 'open' || action === 'fetch') {
    const el = chip(action === 'open' ? 'ready' : 'idle');
    el?.click();
    return Boolean(el);
  }
  if (action === 'share') {
    const el = chip('ready');
    if (!el) return false;
    const at = el.getBoundingClientRect();
    const point = { bubbles: true, clientX: at.left + 10, clientY: at.top + 10, pointerId: 1 };
    el.dispatchEvent(new PointerEvent('pointerdown', point));
    await sleep(800);
    el.dispatchEvent(new PointerEvent('pointerup', point));
    el.dispatchEvent(new MouseEvent('click', point));
    return true;
  }
  if (action === 'link') {
    window.location.href = 'https://example.com/';
    return true;
  }
  return false;
}

export async function runViewerProbe({ query, list, open, close, log }) {
  const rowAt = async (i) => {
    await list.ensure(i).catch(() => {});
    return list.rowAt(i);
  };
  for (const i of parseRows(query.get('measureRows'))) {
    const row = await rowAt(i);
    if (!row) continue;
    resetViewerTimings();
    const t0 = performance.now();
    open(row);
    await sleep(6000);
    const t = viewerTimings();
    log({ viewerMeasure: { row: i, bytes: t.bytes, prepareMs: t.prepareMs, headerMs: ms(t.headerAt, t0), bodyMs: ms(t.bodyAt, t0) } });
    close();
    await sleep(1000);
  }
  const row = await rowAt(Math.max(0, Number(query.get('row')) || 0));
  if (!row) return;
  open(row);
  const after = Number(query.get('loadImagesAfter')) || 0;
  if (after > 0) {
    await sleep(after * 1000);
    const button = document.querySelector('[data-mv-load-images]');
    log({ viewerProbe: 'tap', clicked: Boolean(button), at: Date.now() });
    button?.click();
    await sleep(12_000);
  }
  const actions = String(query.get('attach') || '').split(',').filter(Boolean);
  if (actions.length) {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        log({ viewerProbe: 'visible', path: location.pathname, viewer: Boolean(document.querySelector('.mv-viewer')) });
      }
    });
    await sleep(3000);
    for (const action of actions) {
      log({ viewerProbe: 'attach', action, found: await attachAction(action) });
      await sleep(3000);
    }
    await sleep((Number(query.get('holdAfter')) || 6) * 1000);
  }
  const ports = parsePorts(query.get('controlPorts'));
  if (ports.length) {
    log({ viewerProbe: 'controls', at: Date.now() });
    for (const port of ports) {
      for (const host of HOSTS) {
        const img = new Image();
        img.src = `https://${host}:${port}/control`;
      }
    }
    await sleep(6000);
  }
  log({ viewerProbe: 'done' });
}
