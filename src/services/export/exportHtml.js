import { sanitizeForExport } from './exportSanitize';
import { EXPORT_CSS, EXPORT_WIDTH_PX, headerCardHtml, provenanceHtml, formatStamp } from './exportDocument';

// The exported thread runs on nothing: <details> does the folding, sandbox does
// the isolation, and the heights were measured before the file was written. No
// script means it still works in ten years, offline, in whatever opens it.

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const senderName = (from) => {
  const match = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(from || '');
  return match ? (match[1] || match[2]) : (from || 'Unknown sender');
};

const rootSubject = (s) => String(s || '').replace(/^(\s*(re|fwd|fw)\s*:\s*)+/i, '').trim();

const THREAD_CSS = `
  body { margin: 0 auto; padding: 0 0 40px; }
  .mv-doc { width: ${EXPORT_WIDTH_PX}px; margin: 0 auto; }
  .mv-thread-head { padding: 28px 24px 18px; }
  .mv-thread-head h1 { margin: 0 0 6px; font-size: 20px; }
  .mv-thread-sub { color: #6b7280; font-size: 12.5px; }
  details { border: 1px solid #e3e5ea; border-radius: 8px; margin: 0 24px 10px; background: #fff; }
  summary { cursor: pointer; padding: 12px 14px; font-size: 13px; display: flex; gap: 10px; align-items: baseline; }
  summary::-webkit-details-marker { color: #9aa1ab; }
  .mv-when { color: #6b7280; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .mv-who { font-weight: 600; }
  .mv-alt { color: #6b7280; font-style: italic; }
  details > iframe { display: block; width: 100%; border: 0; border-top: 1px solid #e3e5ea; }
`;

function messageBlock(message, bodyHtml, height, threadSubject, openByDefault) {
  const doc = `<!doctype html><html><head><meta charset="utf-8"><style>${EXPORT_CSS}</style></head>`
    + `<body>${headerCardHtml(message)}<main class="mv-body">${sanitizeForExport(bodyHtml)}</main></body></html>`;
  const ownSubject = rootSubject(message.subject);
  const differs = ownSubject && ownSubject.toLowerCase() !== rootSubject(threadSubject).toLowerCase();
  return `<details${openByDefault ? ' open' : ''}>
  <summary><span class="mv-when">${esc(formatStamp(message.date))}</span><span class="mv-who">${esc(senderName(message.from))}</span>${differs ? `<span class="mv-alt">${esc(ownSubject)}</span>` : ''}</summary>
  <iframe sandbox="allow-same-origin" loading="lazy" style="height:${height}px" srcdoc="${esc(doc)}"></iframe>
</details>`;
}

export function buildThreadDocument({ messages, bodies, heights, account, mailbox, stats }) {
  const ordered = messages.map((m, i) => ({ message: m, body: bodies[i], height: heights[i] }))
    .sort((a, b) => a.message.date - b.message.date);
  const threadSubject = rootSubject(ordered[0]?.message.subject) || '(no subject)';
  const single = ordered.length === 1;
  const first = formatStamp(ordered[0].message.date);
  const last = formatStamp(ordered[ordered.length - 1].message.date);
  const participants = [...new Set(ordered.map(o => senderName(o.message.from)))].join(', ');

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=${EXPORT_WIDTH_PX}">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; frame-src 'self' data:">
<title>${esc(threadSubject)}</title>
<style>${EXPORT_CSS}${THREAD_CSS}</style>
</head>
<body><div class="mv-doc">
<header class="mv-thread-head">
  <h1>${esc(threadSubject)}</h1>
  <div class="mv-thread-sub">${esc(participants)}</div>
  <div class="mv-thread-sub">${ordered.length} message${single ? '' : 's'} &middot; ${esc(first)}${single ? '' : ` &ndash; ${esc(last)}`}</div>
</header>
${ordered.map(o => messageBlock(o.message, o.body, o.height, threadSubject, single)).join('\n')}
${provenanceHtml({ account, mailbox, messages: ordered.map(o => o.message), stats })}
</div></body></html>`;
}
