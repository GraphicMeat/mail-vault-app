// @vitest-environment jsdom
//
// buildThreadDocument sanitizes every body with DOMParser, which the default
// node environment does not provide, and vitest.config.js only maps
// src/components/** to jsdom.
import { describe, it, expect } from 'vitest';
import { buildThreadDocument } from '../exportHtml';

const messages = [
  { from: 'Ana Brandt <ana@sizzlemedia.co>', to: 'Rowan Marsh <rowan@primecut.studio>',
    date: new Date('2026-08-12T09:14:00'), subject: 'Brisket Sans licence', messageId: '<a@x>' },
  { from: 'Rowan Marsh <rowan@primecut.studio>', to: 'Ana Brandt <ana@sizzlemedia.co>',
    date: new Date('2026-08-20T11:30:00'), subject: 'Re: Brisket Sans licence', messageId: '<b@x>' },
  { from: 'Theo Lomas <theo@skewer.systems>', to: 'Rowan Marsh <rowan@primecut.studio>',
    date: new Date('2026-08-28T17:02:00'), subject: 'Re: Brisket Sans licence', messageId: '<c@x>' },
];
const bodies = ['<p>one</p>', '<p>two</p>', '<p>three</p>'];
const heights = [400, 500, 600];
const meta = { account: 'rowan@primecut.studio', mailbox: 'INBOX', stats: { mirrored: 0, failed: 0, pixelsRemoved: 0, bytes: 0 } };

const build = (over = {}) => buildThreadDocument({ messages, bodies, heights, ...meta, ...over });

describe('buildThreadDocument', () => {
  it('is one document per thread, not per message', () => {
    const html = build();
    expect(html.match(/<!doctype html>/gi)).toHaveLength(1);
  });

  it('has one details per message', () => {
    expect(build().match(/<details/g)).toHaveLength(3);
  });

  it('folds every message down by default in a thread', () => {
    expect(build()).not.toContain('<details open');
  });

  it('opens the only message when a single message is exported', () => {
    const html = buildThreadDocument({ messages: [messages[0]], bodies: [bodies[0]], heights: [heights[0]], ...meta });
    expect(html).toContain('<details open');
  });

  it('summarises each message by date-time and sender', () => {
    const html = build();
    expect(html).toContain('Ana Brandt');
    expect(html).toContain('Theo Lomas');
    expect(html).toContain('2026');
    expect(html.match(/<summary/g)).toHaveLength(3);
  });

  it('shows a subject in the summary only when it differs from the thread subject', () => {
    const html = buildThreadDocument({
      messages: [messages[0], { ...messages[1], subject: 'Different topic entirely' }],
      bodies: bodies.slice(0, 2), heights: heights.slice(0, 2), ...meta,
    });
    expect(html).toContain('Different topic entirely');
  });

  it('sandboxes every body and never grants it scripts', () => {
    const html = build();
    expect(html.match(/sandbox="allow-same-origin"/g)).toHaveLength(3);
    expect(html).not.toContain('allow-scripts');
  });

  it('bakes the measured height into each frame', () => {
    const html = build();
    expect(html).toContain('height:400px');
    expect(html).toContain('height:500px');
    expect(html).toContain('height:600px');
  });

  it('escapes the body into the srcdoc attribute', () => {
    const html = buildThreadDocument({
      messages: [messages[0]], bodies: ['<p class="x">quote " and < and &</p>'], heights: [100], ...meta,
    });
    expect(html).toContain('srcdoc="');
    expect(html).toContain('&quot;');
    expect(html).not.toMatch(/srcdoc="[^"]*<p class="x"/);
  });

  it('contains no script element anywhere', () => {
    expect(build()).not.toContain('<script');
  });

  it('carries the provenance footer', () => {
    const html = build();
    expect(html).toContain('rowan@primecut.studio');
    expect(html).toContain('INBOX');
    expect(html).toContain('a@x');
  });

  it('states the mirror result when there was remote content', () => {
    const html = build({ stats: { mirrored: 24, failed: 3, pixelsRemoved: 2, bytes: 900 } });
    expect(html).toContain('24 of 27 remote assets mirrored');
  });

  it('pins the document to the export column width', () => {
    expect(build()).toContain('820px');
  });
});
