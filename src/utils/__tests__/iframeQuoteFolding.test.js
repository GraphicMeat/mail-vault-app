// @vitest-environment jsdom

import { describe, it, expect } from 'vitest';
import { getQuoteFoldingScript, getSignatureFoldingScript } from '../iframeQuoteFolding';
import { setLocale } from '../../i18n/index.js';

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
