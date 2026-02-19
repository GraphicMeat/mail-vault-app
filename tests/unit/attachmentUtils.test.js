import { describe, it, expect } from 'vitest';
import { getRealAttachments, hasRealAttachments } from '../../src/services/attachmentUtils';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const pdfAttachment = {
  filename: 'report.pdf',
  contentType: 'application/pdf',
  size: 102400,
  contentId: null,
  contentDisposition: 'Attachment',
};

const zipAttachment = {
  filename: 'archive.zip',
  contentType: 'application/zip',
  size: 204800,
  contentId: null,
  contentDisposition: 'Attachment',
};

const inlineImage = (cid) => ({
  filename: 'logo.png',
  contentType: 'image/png',
  size: 15000,
  contentId: `<${cid}>`,
  contentDisposition: 'Inline',
});

const trackingPixel = {
  filename: null,
  contentType: 'image/gif',
  size: 43,
  contentId: null,
  contentDisposition: 'Inline',
};

const namedInlineImage = {
  filename: 'photo.jpg',
  contentType: 'image/jpeg',
  size: 50000,
  contentId: null,
  contentDisposition: 'Inline',
};

// ---------------------------------------------------------------------------
// getRealAttachments
// ---------------------------------------------------------------------------

describe('getRealAttachments', () => {
  it('returns empty array for null attachments', () => {
    expect(getRealAttachments(null, '<p>hello</p>')).toEqual([]);
  });

  it('returns empty array for undefined attachments', () => {
    expect(getRealAttachments(undefined, null)).toEqual([]);
  });

  it('returns empty array for empty attachments', () => {
    expect(getRealAttachments([], '<p>hello</p>')).toEqual([]);
  });

  it('returns PDF attachment as real', () => {
    const result = getRealAttachments([pdfAttachment], null);
    expect(result).toHaveLength(1);
    expect(result[0].filename).toBe('report.pdf');
  });

  it('returns multiple non-image attachments', () => {
    const result = getRealAttachments([pdfAttachment, zipAttachment], null);
    expect(result).toHaveLength(2);
  });

  it('adds _originalIndex to each returned attachment', () => {
    const result = getRealAttachments([pdfAttachment, zipAttachment], null);
    expect(result[0]._originalIndex).toBe(0);
    expect(result[1]._originalIndex).toBe(1);
  });

  it('filters out inline image referenced by cid in HTML', () => {
    const img = inlineImage('logo123');
    const html = '<html><body><img src="cid:logo123"></body></html>';
    const result = getRealAttachments([img], html);
    expect(result).toHaveLength(0);
  });

  it('keeps inline image when cid is NOT referenced in HTML', () => {
    const img = inlineImage('logo123');
    const html = '<html><body><p>No images here</p></body></html>';
    const result = getRealAttachments([img], html);
    expect(result).toHaveLength(1);
  });

  it('keeps inline image when there is no HTML body', () => {
    const img = inlineImage('logo123');
    const result = getRealAttachments([img], null);
    expect(result).toHaveLength(1);
  });

  it('filters out tracking pixels (tiny unnamed images)', () => {
    const result = getRealAttachments([trackingPixel], '<p>hello</p>');
    expect(result).toHaveLength(0);
  });

  it('keeps named inline images (not embedded via cid)', () => {
    const result = getRealAttachments([namedInlineImage], '<p>hello</p>');
    expect(result).toHaveLength(1);
    expect(result[0].filename).toBe('photo.jpg');
  });

  it('mixed: keeps real, filters inline cid and tracking pixel', () => {
    const embedded = inlineImage('banner');
    const html = '<img src="cid:banner">';
    const attachments = [pdfAttachment, embedded, trackingPixel, zipAttachment];
    const result = getRealAttachments(attachments, html);
    expect(result).toHaveLength(2);
    expect(result.map(a => a.filename)).toEqual(['report.pdf', 'archive.zip']);
  });

  it('preserves _originalIndex after filtering', () => {
    const embedded = inlineImage('img1');
    const html = '<img src="cid:img1">';
    const attachments = [embedded, pdfAttachment, trackingPixel, zipAttachment];
    const result = getRealAttachments(attachments, html);
    // embedded (idx 0) filtered, pdf (idx 1) kept, pixel (idx 2) filtered, zip (idx 3) kept
    expect(result).toHaveLength(2);
    expect(result[0]._originalIndex).toBe(1);
    expect(result[1]._originalIndex).toBe(3);
  });

  it('handles contentId with angle brackets', () => {
    const img = { ...inlineImage('abc'), contentId: '<abc>' };
    const html = '<img src="cid:abc">';
    const result = getRealAttachments([img], html);
    expect(result).toHaveLength(0);
  });

  it('non-image types are always kept regardless of disposition', () => {
    const inlinePdf = { ...pdfAttachment, contentDisposition: 'Inline' };
    const result = getRealAttachments([inlinePdf], '<p>hello</p>');
    expect(result).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// hasRealAttachments
// ---------------------------------------------------------------------------

describe('hasRealAttachments', () => {
  it('returns false for null email', () => {
    expect(hasRealAttachments(null)).toBe(false);
  });

  it('returns false for email with no attachments', () => {
    expect(hasRealAttachments({ attachments: [] })).toBe(false);
  });

  it('returns false for email with undefined attachments', () => {
    expect(hasRealAttachments({ subject: 'test' })).toBe(false);
  });

  it('returns true for email with PDF attachment', () => {
    expect(hasRealAttachments({
      attachments: [pdfAttachment],
      html: null,
    })).toBe(true);
  });

  it('returns false for email with only embedded inline image', () => {
    const img = inlineImage('cid1');
    expect(hasRealAttachments({
      attachments: [img],
      html: '<img src="cid:cid1">',
    })).toBe(false);
  });

  it('returns false for email with only tracking pixel', () => {
    expect(hasRealAttachments({
      attachments: [trackingPixel],
      html: '<p>hello</p>',
    })).toBe(false);
  });

  it('returns true for mixed (real + inline)', () => {
    const img = inlineImage('logo');
    expect(hasRealAttachments({
      attachments: [img, pdfAttachment],
      html: '<img src="cid:logo">',
    })).toBe(true);
  });
});
