// @vitest-environment jsdom

import { describe, it, expect } from 'vitest';
import { getQuoteFoldingScript, getSignatureFoldingScript } from '../iframeQuoteFolding';
import { setLocale } from '../../i18n/index.js';
import GMAIL_REPLY from './fixtures/quote-fold-gmail-reply.html?raw';

/** Run the injected fold script against `html` the way the iframe does. */
function render(html) {
  document.body.innerHTML = html;
  const js = getQuoteFoldingScript().replace(/<\/?script>/g, '');
  // eslint-disable-next-line no-new-func
  new Function(js)();
}

const folded = () => [...document.querySelectorAll('[data-quote-folded]')];
const toggles = () => [...document.querySelectorAll('[data-quote-toggle]')];
const visibleText = () => [...document.body.children]
  .filter((el) => el.style.display !== 'none')
  .map((el) => el.textContent)
  .join('\n');

// Fastmail's shape when the sender replies to a message: a bold "Original
// Message" header in a plain <div>, then the quoted message as sibling divs.
// No <blockquote>, no gmail_quote class — nothing the selector list can see.
const FASTMAIL_FLAT = `
  <div>Hi Rokas,</div>
  <div><br></div>
  <div>Two more things to add to feature requests</div>
  <div><b>Original Message</b><br>From: Ben &lt;ben@fea.st&gt;<br>Date: Aug 22, 2026, 9:47 AM<br>Subject: Re: [mailvault] other<br>To: prime@graphicmeat.com</div>
  <div>Good morning!</div>
  <div>So much for the drop down not working!</div>
`;

describe('getQuoteFoldingScript', () => {
  it('folds a flat "Original Message" quote that carries no blockquote', () => {
    render(FASTMAIL_FLAT);

    expect(toggles()).toHaveLength(1);
    const quote = folded()[0];
    expect(quote.style.display).toBe('none');
    expect(quote.textContent).toContain('Good morning!');
    expect(quote.textContent).toContain('So much for the drop down');
    expect(quote.textContent).not.toContain('Two more things');
  });

  it('keeps the attribution header and the new message visible', () => {
    render(FASTMAIL_FLAT);

    const shown = visibleText();
    expect(shown).toContain('Hi Rokas,');
    expect(shown).toContain('Two more things');
    expect(shown).toContain('From: Ben');
    expect(shown).not.toContain('Good morning!');
  });

  // The script text is evaluated inside the IFRAME, which has no bundler, no
  // imports and therefore no `t`. A t() call left in the template body threw
  // ReferenceError on the first click and killed the resize message with it.
  it('emits no t() call into the iframe — the strings are already interpolated', () => {
    for (const js of [getQuoteFoldingScript(), getSignatureFoldingScript('collapsed')]) {
      expect(js).not.toMatch(/\bt\(['"`]/);
    }
  });

  it('carries the active catalog into the toggle labels', async () => {
    await setLocale('de');
    try {
      expect(getQuoteFoldingScript()).toContain('Zitierten Text anzeigen');
      expect(getSignatureFoldingScript('collapsed')).toContain('Signatur anzeigen');
    } finally {
      await setLocale('en');
    }
    expect(getQuoteFoldingScript()).toContain('Show quoted text');
  });

  it('reveals the flat quote when the toggle is clicked', () => {
    render(FASTMAIL_FLAT);

    toggles()[0].dispatchEvent(new window.MouseEvent('click'));
    expect(folded()[0].style.display).toBe('');
  });

  it('still folds a blockquote quote', () => {
    render('<p>Answer above.</p><blockquote><p>Quoted line</p></blockquote>');

    expect(toggles()).toHaveLength(1);
    expect(folded()[0].tagName).toBe('BLOCKQUOTE');
    expect(folded()[0].style.display).toBe('none');
  });

  it('folds an Outlook -----Original Message----- divider', () => {
    render(`
      <div>Answer above.</div>
      <div>-----Original Message-----</div>
      <div>From: Someone</div>
      <div>Quoted line</div>
    `);

    expect(toggles()).toHaveLength(1);
    expect(folded()[0].textContent).toContain('Quoted line');
  });

  it('does not fold twice when the attribution line is followed by a blockquote', () => {
    render(`
      <div>Answer above.</div>
      <div>On Fri, Aug 21, 2026, at 8:54 PM, prime@graphicmeat.com wrote:</div>
      <blockquote type="cite"><p>Quoted line</p></blockquote>
    `);

    expect(toggles()).toHaveLength(1);
    expect(folded()).toHaveLength(1);
    expect(folded()[0].tagName).toBe('BLOCKQUOTE');
    expect(visibleText()).toContain('wrote:');
  });

  it('leaves a message with no quote alone', () => {
    render('<div>Just a message.</div><div>Nothing quoted here.</div>');

    expect(toggles()).toHaveLength(0);
    expect(folded()).toHaveLength(0);
  });

  it('ignores the words "original message" inside a sentence', () => {
    render('<div>I re-read your original message twice.</div><div>Thanks!</div>');

    expect(toggles()).toHaveLength(0);
  });
});

// Hidden means hidden by any ancestor: Gmail nests its quote, so a toggle or
// an attribution line can sit inside an element the script folded.
const shown = (node) => {
  for (let n = node.nodeType === 1 ? node : node.parentElement; n && n !== document.body; n = n.parentElement) {
    if (n.style.display === 'none') return false;
  }
  return true;
};
const shownToggles = () => toggles().filter(shown);
const shownText = () => {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let text = '';
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (shown(n) && !n.parentElement.closest('[data-quote-toggle]')) text += n.textContent;
  }
  return text;
};

// Gmail's reply: the attribution line and the quote share one wrapper that
// carries `gmail_quote`, and the quote itself is a `blockquote.gmail_quote`.
// The attribution is localized, so no English "wrote:" to match on.
const GMAIL_ALL_QUOTE = GMAIL_REPLY.replace(/^<div dir="ltr">.*?<\/div><\/div>/, '<div dir="ltr"><br></div>');
const GMAIL_QUOTE = '<blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex"><div dir="ltr">Quoted text.</div></blockquote>';

// Our own wire format, and a reply to our own sent reply: header above the
// quote, the earlier reply nested inside it.
const OWN_HEADER = (n) => `<p><strong>Original Message</strong><br>From: Person A &lt;a@example.com&gt;<br>Date: 26 Sep 2026, 19:4${n}<br>Subject: Question<br>To: b@example.com</p>`;
const OWN_REPLY = `<p>Second reply.</p><hr>${OWN_HEADER(5)}<blockquote><p>First reply.</p><hr>${OWN_HEADER(0)}<blockquote><p>Question text.</p></blockquote></blockquote>`;

describe('getQuoteFoldingScript: one toggle, never a whole message', () => {
  it('Gmail reply: one toggle, attribution and reply visible', () => {
    render(GMAIL_REPLY);

    expect(shownToggles()).toHaveLength(1);
    expect(shownText()).toContain('Reply text.');
    expect(shownText()).toContain('schrieb:');
    expect(shownText()).not.toContain('Quoted paragraph.');
  });

  it('Gmail reply that is all quote: shown whole, no toggle', () => {
    render(GMAIL_ALL_QUOTE);

    expect(toggles()).toHaveLength(0);
    expect(shownText()).toContain('Quoted paragraph.');
  });

  it('a gmail_quote blockquote is one quote, not two toggles', () => {
    render(`<div dir="ltr">Reply text.</div>${GMAIL_QUOTE}`);

    expect(toggles()).toHaveLength(1);
    expect(shownText()).toContain('Reply text.');
    expect(shownText()).not.toContain('Quoted text.');
  });

  it('a reply that is only a gmail_quote blockquote renders as text, not as toggles', () => {
    render(`<div dir="ltr"><br></div>${GMAIL_QUOTE}`);

    expect(toggles()).toHaveLength(0);
    expect(shownText()).toContain('Quoted text.');
  });

  it('own text inside the quote wrapper is never folded away', () => {
    render(`<blockquote><p>Reply typed inside the quote.</p><p>Quoted text.</p></blockquote>`);

    expect(toggles()).toHaveLength(0);
    expect(shownText()).toContain('Reply typed inside the quote.');
  });

  it('our reply to our own sent reply: one toggle, header visible', () => {
    render(OWN_REPLY);

    expect(shownToggles()).toHaveLength(1);
    expect(shownText()).toContain('Second reply.');
    expect(shownText()).toContain('Date: 26 Sep 2026, 19:45');
    expect(shownText()).not.toContain('First reply.');
  });

  it('our reply with no text of its own is shown whole', () => {
    render(`<p></p><hr><blockquote>${OWN_HEADER(0)}<p>Question text.</p></blockquote>`);

    expect(toggles()).toHaveLength(0);
    expect(shownText()).toContain('Question text.');
  });

  it('Thunderbird: the moz-cite-prefix attribution stays visible above one toggle', () => {
    render(`<p>Reply text.</p><div class="moz-cite-prefix">Am 26.09.26 um 19:40 schrieb Person A:<br></div>
      <blockquote type="cite"><p>Quoted text.</p></blockquote>`);

    expect(shownToggles()).toHaveLength(1);
    expect(shownText()).toContain('schrieb Person A:');
    expect(shownText()).not.toContain('Quoted text.');
  });

  it('Outlook: the empty appendonsend marker gets no toggle of its own', () => {
    render(`<div>Reply text.</div><div id="appendonsend"></div><hr>
      <div id="divRplyFwdMsg"><b>From:</b> Person A &lt;a@example.com&gt;<br><b>Sent:</b> Friday, 26 September 2026 19:40</div>
      <div>Quoted text.</div>`);

    expect(toggles()).toHaveLength(1);
    expect(shownText()).toContain('From: Person A');
    expect(shownText()).not.toContain('Quoted text.');
  });

  it('adjacent quotes fold under one toggle that reveals both', () => {
    render('<p>Reply text.</p><blockquote><p>First quote.</p></blockquote>\n<br><blockquote><p>Second quote.</p></blockquote>');

    expect(toggles()).toHaveLength(1);
    toggles()[0].dispatchEvent(new window.MouseEvent('click'));
    expect(shownText()).toContain('First quote.');
    expect(shownText()).toContain('Second quote.');
  });
});
