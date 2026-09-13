/**
 * E2E Test: the reading pane runs nothing an email carries (zero-click)
 *
 * Every frame that shows a received email's HTML carries
 * `sandbox="allow-same-origin allow-popups allow-scripts"`, which is no sandbox
 * at all: the frame runs whatever the mail ships and can reach the parent's IPC
 * bridge (withGlobalTauri + a CSP that allows inline handlers). Nothing strips
 * scripts on the way in. So merely SELECTING an HTML message ran its script —
 * an inline `onerror` and a `<script>` both fired on open, with
 * `top.__TAURI__` in reach.
 *
 * Proof shape (this spec):
 *  - RED at HEAD: the probe records `top.__TAURI__` as "object" from the frame,
 *    with no click anywhere.
 *  - GREEN after the fix: the per-render CSP <meta> (script-src 'nonce-…')
 *    blocks the mail's inline handler and its un-nonced <script>, so the probe
 *    never runs — while our own nonced quote-fold script still folds the
 *    blockquote (a positive control: the fix did not just disable all script).
 *
 * Seam: the message is planted straight into the store the way the original
 * report reproduced it — `window.__MAIL_STORE__` via mailStoreSet — so the frame
 * is reached with zero user interaction.
 */

import { waitForApp, waitForEmails } from './helpers.js';
import { mailStoreSet, firstAccount } from './composeHelpers.js';

const FRAME = 'iframe[title="Email content"]';
const BODY_MARKER = 'Probe body zzz';
const QUOTED_MARKER = 'Quoted line for fold';

// A data: image that cannot decode fires onerror with no network request; the
// inline <script> is the second, independent vector. Both write the same flag,
// recording whether the IPC bridge was in reach when they ran.
const PWN = 'window.__mvReadingPanePwn = typeof top.__TAURI__';
const PAYLOAD_HTML =
  `<p>${BODY_MARKER}</p>`
  + `<img src="data:image/png;base64,AAAA" onerror="${PWN}">`
  + `<script>${PWN}<\/script>`
  + `<blockquote><p>${QUOTED_MARKER}</p></blockquote>`;

function makeEmail(accountId) {
  return {
    uid: 918273,
    _accountId: accountId,
    _mailbox: 'INBOX',
    subject: 'Reading-pane script probe',
    from: { name: 'Probe Sender', address: 'probe@example.com' },
    to: [{ address: 'me@example.com' }],
    cc: [],
    date: '2026-09-13T10:00:00.000Z',
    messageId: '<reading-pane-probe-918273@example.com>',
    html: PAYLOAD_HTML,
    text: BODY_MARKER,
    flags: ['\\Seen'],
  };
}

/** Everything the assertions need, read from inside the reading-pane frame. */
function readFrame() {
  return browser.execute((marker) => {
    const iframe = document.querySelector('iframe[title="Email content"]');
    if (!iframe) return { present: false };
    let doc = null;
    let win = null;
    try { doc = iframe.contentDocument; win = iframe.contentWindow; } catch { /* isolated */ }
    const quotes = doc ? [...doc.querySelectorAll('[data-quote-folded]')] : [];
    return {
      present: true,
      pwn: win ? (win.__mvReadingPanePwn ?? null) : null,
      bodyText: doc && doc.body ? (doc.body.innerText || '') : '',
      hasMarker: !!doc && (doc.body?.innerText || '').includes(marker),
      folded: quotes.length,
      quotesHidden: quotes.length > 0 && quotes.every((q) => q.style.display === 'none'),
    };
  }, BODY_MARKER);
}

describe('reading pane runs nothing an email carries', function () {
  this.timeout(90_000);

  before(async function () {
    await waitForApp();
    await waitForEmails();
  });

  it('opens an HTML message without running its script or reaching IPC', async function () {
    const account = await firstAccount();
    expect(account).not.toBe(null);

    // Zero-click: plant the message as the selection, exactly as reported.
    await mailStoreSet({
      selectedThread: null,
      selectedEmail: makeEmail(account.id),
      selectedEmailId: 918273,
    });

    // Wait for the frame to render the body — never for the flag; the whole
    // point is that the flag must stay unset.
    await browser.waitUntil(async () => {
      const f = await readFrame();
      return f.present && f.hasMarker;
    }, { timeout: 30_000, interval: 300, timeoutMsg: 'reading-pane frame never rendered the probe body' });

    // Long enough for a broken image to fail and any handler to fire.
    await browser.pause(2500);

    const frame = await readFrame();
    // The bug: an email-authored handler/script ran and saw the bridge.
    expect(frame.pwn).toBe(null);
    // Non-vacuous: the body really did render (so "nothing ran" means the CSP
    // stopped the script, not that the frame is empty).
    expect(frame.hasMarker).toBe(true);
    // Positive control: our OWN nonced quote-fold script still ran, so the fix
    // blocked the mail's script without disabling script wholesale.
    expect(frame.folded).toBeGreaterThan(0);
    expect(frame.quotesHidden).toBe(true);
  });
});
