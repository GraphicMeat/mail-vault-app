import { sanitizeForExport } from './exportSanitize';
import { t as tr } from '../../i18n/index.js';
import { EXPORT_CSS, EXPORT_WIDTH_PX, headerCardHtml, provenanceHtml, formatStamp } from './exportDocument';

// The exported thread runs on almost nothing: <details> does the folding,
// sandbox does the isolation, and the heights were measured before the file was
// written. It reads offline, in ten years, with scripting off.
//
// The one script is an ENHANCEMENT, never a dependency. It fits each frame to
// its content once the column has reflowed, and drives the fold/unfold-all
// buttons. With scripting off you still get the baked heights and per-message
// <details> toggles — the layout below is CSS-only. And the message frames stay
// inert either way: their sandbox has no allow-scripts, so nothing in an email
// can execute no matter what the outer document is allowed to do.

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const senderName = (from) => {
  const match = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(from || '');
  return match ? (match[1] || match[2]) : (from || tr('svc.exportDocument.unknownSender'));
};

const rootSubject = (s) => String(s || '').replace(/^(\s*(re|fwd|fw)\s*:\s*)+/i, '').trim();

const THREAD_CSS = `
  /* EXPORT_CSS caps the body for the rasterizer, which renders in a frame of
     exactly one width. The document opens in a window of any width. */
  body { max-width: none; margin: 0; padding: 0; }
  .mv-shell { display: grid; grid-template-columns: 236px minmax(0, 1fr); align-items: start;
              max-width: ${EXPORT_WIDTH_PX + 260}px; margin: 0 auto; }
  /* One message has no chronology to list and nothing to fold. */
  .mv-shell.mv-solo { grid-template-columns: minmax(0, 1fr); max-width: ${EXPORT_WIDTH_PX + 24}px; }
  .mv-main { min-width: 0; padding-bottom: 40px; }

  .mv-rail { position: sticky; top: 0; max-height: 100vh; overflow: auto;
             padding: 20px 14px; border-right: 1px solid #e3e5ea; }
  .mv-rail-title { font-size: 11px; text-transform: uppercase; letter-spacing: .06em;
                   color: #9aa1ab; margin: 0 0 10px; }
  .mv-rail-actions { display: flex; gap: 6px; margin-bottom: 14px; }
  .mv-rail-actions button { flex: 1; font: inherit; font-size: 12px; padding: 6px 8px; cursor: pointer;
                            border: 1px solid #e3e5ea; border-radius: 6px; background: #fff; color: #16181d; }
  .mv-rail-actions button:hover { background: #f4f5f8; }
  /* Nothing to press without the script, so the buttons do not pretend to be there. */
  html:not(.mv-js) .mv-rail-actions { display: none; }

  .mv-toc { list-style: none; margin: 0; padding: 0; }
  .mv-toc a { display: grid; grid-template-columns: 18px minmax(0, 1fr); gap: 8px;
              padding: 7px 8px; border-radius: 6px; text-decoration: none; color: inherit; }
  .mv-toc a:hover { background: #f4f5f8; }
  .mv-toc .mv-n { color: #9aa1ab; font-size: 11px; font-variant-numeric: tabular-nums; padding-top: 2px; }
  .mv-toc .mv-who { display: block; font-size: 12.5px; font-weight: 600; }
  .mv-toc .mv-when { display: block; font-size: 11px; color: #6b7280; font-variant-numeric: tabular-nums; }

  .mv-thread-head { padding: 28px 24px 18px; }
  .mv-thread-head h1 { margin: 0 0 6px; font-size: 20px; overflow-wrap: anywhere; }
  .mv-thread-sub { color: #6b7280; font-size: 12.5px; overflow-wrap: anywhere; }

  details { border: 1px solid #e3e5ea; border-radius: 8px; margin: 0 24px 10px; background: #fff;
            scroll-margin-top: 12px; }
  summary { cursor: pointer; padding: 12px 14px; font-size: 13px; display: flex; gap: 10px;
            align-items: baseline; flex-wrap: wrap; list-style: none; }
  /* display:flex swallows the native marker, so the rows read as cards with no
     hint that they open. One drawn here instead, in both spellings. */
  summary::-webkit-details-marker { display: none; }
  summary::before { content: '\\25B8'; color: #9aa1ab; display: inline-block;
                    transition: transform .15s ease; }
  details[open] > summary::before { transform: rotate(90deg); }
  .mv-when { color: #6b7280; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .mv-who { font-weight: 600; }
  .mv-alt { color: #6b7280; font-style: italic; overflow-wrap: anywhere; }
  details > iframe { display: block; width: 100%; border: 0; border-top: 1px solid #e3e5ea; }

  @media (max-width: 820px) {
    .mv-shell { grid-template-columns: minmax(0, 1fr); }
    .mv-rail { position: static; max-height: none; border-right: 0; border-bottom: 1px solid #e3e5ea; }
    .mv-toc { display: flex; flex-wrap: wrap; gap: 4px; }
    .mv-toc a { grid-template-columns: auto; }
    .mv-toc .mv-when { display: none; }
    details { margin-left: 12px; margin-right: 12px; }
    .mv-thread-head { padding: 20px 12px 14px; }
  }
`;

// Sizing has to survive a reflow: the baked height was measured at one column
// width, and a narrower window makes the same mail taller. Reading the frame's
// own document needs allow-same-origin, which srcdoc frames have here — if a
// browser refuses it anyway, the baked height stays and nothing throws.
const THREAD_JS = `
document.documentElement.className += ' mv-js';
function fit(f) {
  try {
    var d = f.contentDocument;
    if (!d || !d.body) return;
    // Collapse first. scrollHeight on a frame TALLER than its content returns
    // the frame's own height, so measuring against the baked height can only
    // ever grow it — a widened window would keep the tall one forever.
    var was = f.style.height;
    f.style.height = '1px';
    // scrollHeight rounds DOWN, and a frame a quarter-pixel short of its
    // content grows a scrollbar over it. Ceil the measured box.
    var h = Math.ceil(Math.max(
      d.documentElement.scrollHeight,
      d.body.scrollHeight,
      d.documentElement.getBoundingClientRect().height
    ));
    f.style.height = h > 0 ? h + 'px' : was;
  } catch (e) {}
}
function fitAll() {
  var frames = document.querySelectorAll('details > iframe');
  for (var i = 0; i < frames.length; i++) fit(frames[i]);
}
document.addEventListener('load', function (e) {
  if (e.target && e.target.tagName === 'IFRAME') fit(e.target);
}, true);
// A folded frame is lazy: it has no layout until the details opens, and its
// load may already have fired by the time it becomes visible.
document.addEventListener('toggle', function (e) {
  if (e.target && e.target.tagName === 'DETAILS') setTimeout(fitAll, 0);
}, true);
var t;
addEventListener('resize', function () { clearTimeout(t); t = setTimeout(fitAll, 120); });
var buttons = document.querySelectorAll('[data-mv-all]');
for (var i = 0; i < buttons.length; i++) {
  buttons[i].addEventListener('click', function () {
    var open = this.getAttribute('data-mv-all') === 'open';
    var all = document.querySelectorAll('details');
    for (var j = 0; j < all.length; j++) all[j].open = open;
  });
}
addEventListener('load', fitAll);
fitAll();
`;

function messageBlock(message, bodyHtml, height, threadSubject, openByDefault, id) {
  const doc = `<!doctype html><html><head><meta charset="utf-8"><style>${EXPORT_CSS}</style></head>`
    + `<body>${headerCardHtml(message)}<main class="mv-body">${sanitizeForExport(bodyHtml)}</main></body></html>`;
  const ownSubject = rootSubject(message.subject);
  const differs = ownSubject && ownSubject.toLowerCase() !== rootSubject(threadSubject).toLowerCase();
  return `<details${openByDefault ? ' open' : ''} id="${id}">
  <summary><span class="mv-when">${esc(formatStamp(message.date))}</span><span class="mv-who">${esc(senderName(message.from))}</span>${differs ? `<span class="mv-alt">${esc(ownSubject)}</span>` : ''}</summary>
  <iframe sandbox="allow-same-origin" loading="lazy" style="height:${height}px" srcdoc="${esc(doc)}"></iframe>
</details>`;
}

// The rail is the thread in order, oldest first — the same order the messages
// are laid out in, so the list reads as the chronology rather than as a menu.
function railHtml(ordered) {
  const items = ordered.map((o, i) => `<li><a href="#mv-m${i + 1}">
      <span class="mv-n">${i + 1}</span>
      <span><span class="mv-who">${esc(senderName(o.message.from))}</span><span class="mv-when">${esc(formatStamp(o.message.date))}</span></span>
    </a></li>`).join('\n');
  return `<nav class="mv-rail">
  <p class="mv-rail-title">${ordered.length} message${ordered.length === 1 ? '' : 's'}</p>
  <div class="mv-rail-actions">
    <button type="button" data-mv-all="open">Unfold all</button>
    <button type="button" data-mv-all="close">Fold all</button>
  </div>
  <ol class="mv-toc">
${items}
  </ol>
</nav>`;
}

export function buildThreadDocument({ messages, bodies, heights, account, mailbox, stats }) {
  const ordered = messages.map((m, i) => ({ message: m, body: bodies[i], height: heights[i] }))
    .sort((a, b) => a.message.date - b.message.date);
  const threadSubject = rootSubject(ordered[0]?.message.subject) || tr('svc.exportDocument.noSubject');
  const single = ordered.length === 1;
  const first = formatStamp(ordered[0].message.date);
  const last = formatStamp(ordered[ordered.length - 1].message.date);
  const participants = [...new Set(ordered.map(o => senderName(o.message.from)))].join(', ');

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-src 'self' data:">
<title>${esc(threadSubject)}</title>
<style>${EXPORT_CSS}${THREAD_CSS}</style>
</head>
<body><div class="mv-shell${single ? ' mv-solo' : ''}">
${single ? '' : railHtml(ordered)}
<main class="mv-main">
<header class="mv-thread-head">
  <h1>${esc(threadSubject)}</h1>
  <div class="mv-thread-sub">${esc(participants)}</div>
  <div class="mv-thread-sub">${ordered.length} message${single ? '' : 's'} &middot; ${esc(first)}${single ? '' : ` &ndash; ${esc(last)}`}</div>
</header>
${ordered.map((o, i) => messageBlock(o.message, o.body, o.height, threadSubject, single, `mv-m${i + 1}`)).join('\n')}
${provenanceHtml({ account, mailbox, messages: ordered.map(o => o.message), stats })}
</main>
</div>
<script>${THREAD_JS}</script>
</body></html>`;
}
