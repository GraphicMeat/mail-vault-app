// @vitest-environment jsdom
//
// buildMessageDocument runs the body through sanitizeForExport, which parses
// with DOMParser — absent from the default node environment, and
// vitest.config.js only maps src/components/** to jsdom.
import { describe, it, expect } from 'vitest';
import { buildMessageDocument, headerCardHtml, provenanceHtml, EXPORT_WIDTH_PX } from '../exportDocument';

const message = {
  from: 'Ana Brandt <ana@sizzlemedia.co>',
  to: 'Rowan Marsh <rowan@primecut.studio>',
  cc: '',
  date: new Date('2026-08-28T09:14:00'),
  subject: 'Brisket Sans licence renews 4 September',
  messageId: '<abc@sizzlemedia.co>',
  custody: 'archived',
};

describe('headerCardHtml', () => {
  it('carries sender, recipient, date and subject', () => {
    const html = headerCardHtml(message);
    expect(html).toContain('Ana Brandt');
    expect(html).toContain('Rowan Marsh');
    expect(html).toContain('Brisket Sans licence renews 4 September');
    expect(html).toContain('2026');
  });

  it('escapes markup in header values', () => {
    const html = headerCardHtml({ ...message, subject: '<script>x</script>' });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('omits the cc row when there is no cc', () => {
    expect(headerCardHtml(message)).not.toContain('Cc');
    expect(headerCardHtml({ ...message, cc: 'Theo <theo@skewer.systems>' })).toContain('Cc');
  });

  // The shape the app really stores: `from` an object, `to`/`cc` arrays of them.
  // Read as strings they rendered as "[object Object]" in the card the PNG is
  // rasterized from — the fixture above is the only reason that ever looked fine.
  it('renders the object form the app stores, not [object Object]', () => {
    const html = headerCardHtml({
      ...message,
      from: { name: 'Ana Brandt', address: 'ana@sizzlemedia.co' },
      to: [{ name: 'Rowan Marsh', address: 'rowan@primecut.studio' },
           { address: 'theo@skewer.systems' }],
      cc: [],
    });
    expect(html).not.toContain('[object Object]');
    expect(html).toContain('Ana Brandt');
    expect(html).toContain('rowan@primecut.studio');
    expect(html).toContain('theo@skewer.systems');
    expect(html).not.toContain('Cc');
  });
});

describe('provenanceHtml', () => {
  it('names account, folder, message-id and custody', () => {
    const html = provenanceHtml({
      account: 'rowan@primecut.studio',
      mailbox: 'INBOX',
      messages: [message],
      stats: { mirrored: 24, failed: 3, pixelsRemoved: 2, bytes: 100 },
    });
    expect(html).toContain('rowan@primecut.studio');
    expect(html).toContain('INBOX');
    expect(html).toContain('abc@sizzlemedia.co');
    expect(html).toContain('archived');
  });

  it('states the mirror result honestly', () => {
    const html = provenanceHtml({
      account: 'a@b.test',
      mailbox: 'INBOX',
      messages: [message],
      stats: { mirrored: 24, failed: 3, pixelsRemoved: 2, bytes: 100 },
    });
    expect(html).toContain('24 of 27 remote assets mirrored');
    expect(html).toContain('3 unavailable');
    expect(html).toContain('2 tracking pixels removed');
  });

  it('counts removed pixels even when nothing was mirrored', () => {
    const html = provenanceHtml({
      account: 'a@b.test',
      mailbox: 'INBOX',
      messages: [message],
      stats: { mirrored: 0, failed: 0, pixelsRemoved: 2, bytes: 0 },
    });
    expect(html).toContain('2 tracking pixels removed');
    expect(html).not.toContain('remote assets mirrored');
  });

  it('says nothing about mirroring when there was nothing remote', () => {
    const html = provenanceHtml({
      account: 'a@b.test',
      mailbox: 'INBOX',
      messages: [message],
      stats: { mirrored: 0, failed: 0, pixelsRemoved: 0, bytes: 0 },
    });
    expect(html).not.toContain('remote assets mirrored');
  });
});

describe('buildMessageDocument', () => {
  it('is a full document fixed to the export width', () => {
    const html = buildMessageDocument({ message, bodyHtml: '<p>hi</p>' });
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain(`${EXPORT_WIDTH_PX}px`);
    expect(html).toContain('<p>hi</p>');
  });

  it('widens the column to a given width, and is unchanged without one', () => {
    const html = buildMessageDocument({ message, bodyHtml: '<p>hi</p>', width: 1200 });
    expect(html).toContain('body { max-width: 1200px; }');
    expect(buildMessageDocument({ message, bodyHtml: '<p>hi</p>' })).not.toContain('1200px');
  });

  it('carries no script of its own', () => {
    const html = buildMessageDocument({ message, bodyHtml: '<p>hi</p>' });
    expect(html).not.toContain('<script');
  });

  it('sanitizes the body it is handed', () => {
    const html = buildMessageDocument({ message, bodyHtml: '<p>hi</p><script>evil()</script>' });
    expect(html).not.toContain('evil()');
    expect(html).toContain('<p>hi</p>');
  });

  // The rasterizer has no reader to follow: an image is one set of pixels. The
  // HTML export follows the reader's scheme; this document never does.
  it('forces a light background regardless of app theme', () => {
    const html = buildMessageDocument({ message, bodyHtml: '<p>hi</p>' });
    expect(html).toContain('color-scheme: light');
    expect(html).toContain('#ffffff');
    expect(html).not.toContain('prefers-color-scheme');
  });
});

// A social card rasterizes its header and its body apart, each in its own theme.
describe('buildMessageDocument parts', () => {
  const whole = () => buildMessageDocument({ message, bodyHtml: '<p>hi</p>' });

  it('the default is unchanged by the part options being absent or neutral', () => {
    expect(buildMessageDocument({ message, bodyHtml: '<p>hi</p>', theme: 'light', extraHead: '' })).toBe(whole());
    expect(buildMessageDocument({ message, bodyHtml: '<p>hi</p>', theme: 'dark' })).toBe(whole());
  });

  it('head: the header block alone, no body', () => {
    const html = buildMessageDocument({ message, bodyHtml: '<p>hi</p>', part: 'head' });
    expect(html).toContain('class="mv-head"');
    expect(html).not.toContain('<main');
    expect(html).not.toContain('<p>hi</p>');
    expect(html).not.toContain('#1e1f22');
  });

  it('head, dark: plain CSS in the dark card colors, no script', () => {
    const html = buildMessageDocument({ message, part: 'head', theme: 'dark' });
    expect(html).toContain('color-scheme: dark');
    for (const color of ['#1e1f22', '#e6e7ea', '#9aa1ab', '#34363b']) expect(html).toContain(color);
    expect(html).not.toContain('<script');
  });

  it('body: the mail alone, no header', () => {
    const html = buildMessageDocument({ message, bodyHtml: '<p>hi</p>', part: 'body' });
    expect(html).toContain('<main class="mv-body"><p>hi</p></main>');
    expect(html).not.toContain('mv-head"');
    expect(html).not.toContain('Brisket Sans licence');
  });

  it('body, dark: inline color priorities are dropped for Dark Reader; the sanitizer still runs', () => {
    const body = '<p style="color:#000 !important;margin:0 !important">hi</p><script>evil()</script>';
    const html = buildMessageDocument({ message, bodyHtml: body, part: 'body', theme: 'dark' });
    expect(html).toContain('color:#000');
    expect(html).not.toContain('color:#000 !important');
    expect(html).toContain('margin:0 !important');
    expect(html).not.toContain('evil()');
    // Light keeps them.
    expect(buildMessageDocument({ message, bodyHtml: body, part: 'body' })).toContain('color:#000 !important');
  });

  it('extraHead lands after the stylesheet, inside the head', () => {
    const html = buildMessageDocument({ message, bodyHtml: '<p>hi</p>', part: 'body', extraHead: '<meta name="x">' });
    expect(html).toMatch(/<\/style><meta name="x"><\/head>/);
  });

  describe('extrasHtml (the boxes under a card\'s header)', () => {
    const extras = '<section class="mv-box">Sender Details &lt;x&gt;</section><section class="mv-box">Links</section>';

    it('head: the boxes follow the header block, styled, before any body', () => {
      const html = buildMessageDocument({ message, bodyHtml: '<p>hi</p>', part: 'head', extrasHtml: extras });
      expect(html).toContain(extras);
      // The class name is also a CSS rule in <head>: look for the element.
      expect(html.indexOf('</header>')).toBeLessThan(html.indexOf('<section class="mv-panels">'));
      expect(html.indexOf('<section class="mv-panels">')).toBeLessThan(html.indexOf(extras));
      expect(html).toContain('.mv-box {');
      expect(html).not.toContain('<main');
    });

    it('body: never carries them, nor their styles', () => {
      const html = buildMessageDocument({ message, bodyHtml: '<p>hi</p>', part: 'body', extrasHtml: extras });
      expect(html).not.toContain('mv-box');
      expect(html).not.toContain('mv-panels');
      expect(html).not.toContain('Sender Details');
      expect(html).toBe(buildMessageDocument({ message, bodyHtml: '<p>hi</p>', part: 'body' }));
    });

    it('without extras the document is byte-identical to before', () => {
      expect(buildMessageDocument({ message, part: 'head', extrasHtml: '' })).toBe(buildMessageDocument({ message, part: 'head' }));
      expect(buildMessageDocument({ message, part: 'head' })).not.toContain('mv-box');
    });

    it('head, dark: the boxes take the dark colors', () => {
      const dark = buildMessageDocument({ message, part: 'head', theme: 'dark', extrasHtml: extras });
      expect(dark).toContain('#34363b');
      expect(dark).toContain('#f87171');
      const light = buildMessageDocument({ message, part: 'head', extrasHtml: extras });
      expect(light).not.toContain('#f87171');
    });
  });
});
