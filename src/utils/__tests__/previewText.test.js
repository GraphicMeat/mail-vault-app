// @vitest-environment jsdom
//
// A row's preview line is text lifted out of the message, and a marketing
// mail's preheader is padded with `&zwnj;` so a client shows nothing after
// the teaser. Printed raw, the padding was the preview.
import { describe, it, expect } from 'vitest';
import { cleanPreviewText } from '../previewText';

describe('cleanPreviewText', () => {
  it('drops the zero-width padding a preheader carries, as entity or as character', () => {
    const raw = 'Don’t miss 30% off photo books + 20% off all other formats. &zwnj; &zwnj; &zwnj; &zwnj;‌ ‌&nbsp;&shy;­͏﻿';
    expect(cleanPreviewText(raw)).toBe('Don’t miss 30% off photo books + 20% off all other formats.');
  });

  it('decodes the entities a text part can still carry', () => {
    expect(cleanPreviewText('Tom &amp; Jerry &rsquo;s &#8212; &#x2764; &hellip;')).toBe('Tom & Jerry ’s — ❤ …');
  });

  it('leaves ordinary text and markup-looking text alone', () => {
    expect(cleanPreviewText('a < b and <b>not bold</b>')).toBe('a < b and <b>not bold</b>');
    expect(cleanPreviewText('')).toBe('');
    expect(cleanPreviewText(undefined)).toBe('');
  });

  it('drops an entity the snippet cap cut in half, but not an ending the cap never cut', () => {
    const head = 'Mokėtina suma 40,25 EUR Būsime dėkingi, jeigu sąskaitą apmokėsite iki ';
    expect(cleanPreviewText(`${head.repeat(3)}&scar`)).toBe(head.repeat(3).trim());
    expect(cleanPreviewText(`${'x'.repeat(200)} &#82`)).toBe('x'.repeat(200));
    // short: nothing was cut, so an ampersand word at the end is the text
    expect(cleanPreviewText('Meet me at AT&T')).toBe('Meet me at AT&T');
    // a whole entity still decodes
    expect(cleanPreviewText(`${'x'.repeat(200)} &scaron;`)).toBe(`${'x'.repeat(200)} š`);
  });
});
