import { describe, it, expect } from 'vitest';
import { htmlReferencesCid } from '../cidRefs';
import { replaceCidUrls } from '../../services/attachmentUtils';

// Outlook writes the Content-ID with its '@' percent-encoded in the body
// (`src="cid:image001.png%4001DC1234.AB56CD70"`) while the part header carries
// it raw (`<image001.png@01DC1234.AB56CD70>`). Matching the two as plain text
// left the image with no bytes: a bordered empty box in the reading pane.
const RAW = 'image001.png@01DC1234.AB56CD70';
const att = { contentId: `<${RAW}>`, contentType: 'image/png', content: 'QUJD' };

describe('htmlReferencesCid', () => {
  it('matches a raw reference', () => {
    expect(htmlReferencesCid(`<img src="cid:${RAW}">`, RAW)).toBe(true);
  });

  it('matches a percent-encoded reference', () => {
    expect(htmlReferencesCid('<img src="cid:image001.png%4001DC1234.AB56CD70">', RAW)).toBe(true);
  });

  it('matches a lower-case percent escape', () => {
    expect(htmlReferencesCid('<img src="cid:a%2fb@x">', 'a/b@x')).toBe(true);
  });

  it('does not match another id, or a prefix of one', () => {
    expect(htmlReferencesCid('<img src="cid:image001.png@01DC1234.AB56CD70X">', RAW)).toBe(false);
    expect(htmlReferencesCid('<img src="cid:other@x">', RAW)).toBe(false);
  });

  it('survives a malformed escape', () => {
    expect(htmlReferencesCid('<img src="cid:100%zz">', RAW)).toBe(false);
  });
});

describe('replaceCidUrls', () => {
  it('fills a percent-encoded reference with the part bytes', () => {
    const out = replaceCidUrls('<img src="cid:image001.png%4001DC1234.AB56CD70">', [att]);
    expect(out).toBe('<img src="data:image/png;base64,QUJD">');
  });

  it('still fills a raw reference, every occurrence', () => {
    const out = replaceCidUrls(`<img src="cid:${RAW}"><img src='cid:${RAW}'>`, [att]);
    expect(out).toBe('<img src="data:image/png;base64,QUJD"><img src=\'data:image/png;base64,QUJD\'>');
  });

  it('leaves a reference with no matching part alone', () => {
    const html = '<img src="cid:missing@x">';
    expect(replaceCidUrls(html, [att])).toBe(html);
  });
});
