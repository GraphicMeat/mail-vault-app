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

  it('carries no script of its own', () => {
    const html = buildMessageDocument({ message, bodyHtml: '<p>hi</p>' });
    expect(html).not.toContain('<script');
  });

  it('sanitizes the body it is handed', () => {
    const html = buildMessageDocument({ message, bodyHtml: '<p>hi</p><script>evil()</script>' });
    expect(html).not.toContain('evil()');
    expect(html).toContain('<p>hi</p>');
  });

  it('forces a light background regardless of app theme', () => {
    const html = buildMessageDocument({ message, bodyHtml: '<p>hi</p>' });
    expect(html).toContain('color-scheme: light');
    expect(html).toContain('#ffffff');
  });
});
