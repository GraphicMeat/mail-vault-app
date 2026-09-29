// @vitest-environment jsdom

// A signature logo rides along on every email the account sends, so its size
// is graded where it is added: under 100 KB perfect, 100 to 200 KB ok-ish,
// over 200 KB too large. The grade is taken on the whole KB the UI shows, so
// the number on screen and the colour next to it can never disagree.
import { describe, it, expect } from 'vitest';
import {
  KB,
  SIGNATURE_IMAGE_GOOD_BELOW_KB,
  SIGNATURE_IMAGE_WARN_MAX_KB,
  classifySignatureImageSize,
  dataUriBytes,
  signatureImageBytes,
  signatureImageKb,
  signatureHasContent,
} from '../signatureImages';

// Base64 that decodes to exactly `n` bytes.
const base64OfBytes = (n) =>
  'A'.repeat(4 * Math.floor(n / 3)) + (n % 3 === 1 ? 'AA==' : n % 3 === 2 ? 'AAA=' : '');

describe('signature image size thresholds', () => {
  it('are 100 KB and 200 KB of 1024 bytes', () => {
    expect(KB).toBe(1024);
    expect(SIGNATURE_IMAGE_GOOD_BELOW_KB).toBe(100);
    expect(SIGNATURE_IMAGE_WARN_MAX_KB).toBe(200);
  });

  it.each([
    [99 * KB, 'good'],
    [100 * KB, 'warn'],
    [200 * KB, 'warn'],
    [201 * KB, 'alert'],
  ])('grades %i bytes as %s', (bytes, tier) => {
    expect(classifySignatureImageSize(bytes)).toBe(tier);
  });

  it('grades on the whole KB it shows', () => {
    // 99.4 KB shows as 99 KB, 200.6 KB as 201 KB.
    expect(signatureImageKb(Math.floor(99.4 * KB))).toBe(99);
    expect(classifySignatureImageSize(Math.floor(99.4 * KB))).toBe('good');
    expect(signatureImageKb(Math.ceil(200.6 * KB))).toBe(201);
    expect(classifySignatureImageSize(Math.ceil(200.6 * KB))).toBe('alert');
  });

  it('shows a tiny image as 1 KB, and grades no image at all as nothing', () => {
    expect(signatureImageKb(300)).toBe(1);
    expect(classifySignatureImageSize(300)).toBe('good');
    expect(classifySignatureImageSize(0)).toBeNull();
  });
});

describe('dataUriBytes', () => {
  it('counts the decoded file bytes, not the base64 text', () => {
    for (const n of [1, 2, 3, 1000, 102400]) {
      expect(dataUriBytes(`data:image/png;base64,${base64OfBytes(n)}`)).toBe(n);
    }
  });

  it('ignores line breaks inside the payload', () => {
    expect(dataUriBytes('data:image/png;base64,AAAA\r\nAAAA')).toBe(6);
  });

  it('is 0 for anything that is not a base64 data URI', () => {
    expect(dataUriBytes('https://example.com/logo.png')).toBe(0);
    expect(dataUriBytes('cid:logo@x')).toBe(0);
    expect(dataUriBytes('data:text/plain,hello')).toBe(0);
  });
});

describe('signatureImageBytes', () => {
  it('adds up every embedded picture in the signature', () => {
    const html = `<p>Rokas</p><p><img src="data:image/png;base64,${base64OfBytes(3000)}" alt="logo.png">`
      + `<img src="data:image/jpeg;base64,${base64OfBytes(1500)}" alt="badge.jpg"></p>`;
    expect(signatureImageBytes(html)).toBe(4500);
  });

  it('leaves remote pictures out: they are not sent with the message', () => {
    expect(signatureImageBytes('<p><img src="https://example.com/logo.png"></p>')).toBe(0);
    expect(signatureImageBytes('')).toBe(0);
    expect(signatureImageBytes('<p>Best regards</p>')).toBe(0);
  });
});

describe('signatureHasContent', () => {
  it('counts a logo with no words as a signature', () => {
    expect(signatureHasContent('<p><img src="data:image/png;base64,AAAA" alt="logo.png"></p>', '')).toBe(true);
  });

  it('counts words, and nothing else as empty', () => {
    expect(signatureHasContent('<p>Rokas</p>', 'Rokas')).toBe(true);
    expect(signatureHasContent('<p></p>', '')).toBe(false);
    expect(signatureHasContent('', '')).toBe(false);
  });
});
