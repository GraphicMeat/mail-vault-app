import { describe, it, expect, vi } from 'vitest';
import { getRealAttachments, hasRealAttachments, hydrateInlineImages, replaceCidUrls } from '../../src/services/attachmentUtils';

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

// ---------------------------------------------------------------------------
// replaceCidUrls
// ---------------------------------------------------------------------------

describe('replaceCidUrls', () => {
  const withContent = (cid, extra = {}) => ({ ...inlineImage(cid), content: 'AAAA', ...extra });

  it('returns the input untouched when there is no html or no attachments', () => {
    expect(replaceCidUrls(null, [withContent('a')])).toBeNull();
    expect(replaceCidUrls('', [withContent('a')])).toBe('');
    const html = '<img src="cid:a">';
    expect(replaceCidUrls(html, [])).toBe(html);
    expect(replaceCidUrls(html, undefined)).toBe(html);
  });

  it('leaves the cid: in place when the attachment carries no bytes', () => {
    const html = '<img src="cid:logo">';
    expect(replaceCidUrls(html, [inlineImage('logo')])).toBe(html);
  });

  it('resolves a Content-ID written without angle brackets', () => {
    expect(replaceCidUrls('<img src="cid:bare">', [withContent('bare', { contentId: 'bare' })]))
      .toBe('<img src="data:image/png;base64,AAAA">');
  });

  it('drops content-type parameters from the data: URI', () => {
    expect(replaceCidUrls('<img src="cid:x">', [withContent('x', { contentType: 'image/jpeg; name="p.jpg"' })]))
      .toBe('<img src="data:image/jpeg;base64,AAAA">');
  });

  it('falls back to application/octet-stream when the type is missing', () => {
    expect(replaceCidUrls('<img src="cid:x">', [withContent('x', { contentType: undefined })]))
      .toBe('<img src="data:application/octet-stream;base64,AAAA">');
  });

  it('replaces every reference to one cid', () => {
    expect(replaceCidUrls('<img src="cid:x"><a href="cid:x">', [withContent('x')]))
      .toBe('<img src="data:image/png;base64,AAAA"><a href="data:image/png;base64,AAAA">');
  });

  it('resolves each cid to its own attachment', () => {
    const out = replaceCidUrls('<img src="cid:a"><img src="cid:b">', [
      withContent('a', { content: 'AAAA' }),
      withContent('b', { content: 'BBBB' }),
    ]);
    expect(out).toBe('<img src="data:image/png;base64,AAAA"><img src="data:image/png;base64,BBBB">');
  });

  it('leaves an attachment whose cid the html never mentions alone', () => {
    const html = '<p>no pictures</p>';
    expect(replaceCidUrls(html, [withContent('unused')])).toBe(html);
  });
});

describe('hydrateInlineImages', () => {
  const email = {
    uid: 42,
    html: '<img src="cid:logo"><img src="cid:unused">',
    attachments: [pdfAttachment, inlineImage('logo'), inlineImage('other')],
  };

  it('returns the same object outside Tauri', async () => {
    globalThis.window = {};
    expect(await hydrateInlineImages(email, 'acct', 'INBOX')).toBe(email);
  });

  it('does not re-read an attachment that already carries its bytes', async () => {
    const invoke = vi.fn(async () => 'FRESH');
    globalThis.window = { __TAURI__: { core: { invoke } } };
    const cached = { ...email, attachments: [pdfAttachment, { ...inlineImage('logo'), content: 'CACHED' }] };

    const result = await hydrateInlineImages(cached, 'acct', 'INBOX');

    expect(invoke).not.toHaveBeenCalled();
    expect(result).toBe(cached);
  });

  it('skips an inline image over the 10MB cap', async () => {
    const invoke = vi.fn(async () => 'X');
    globalThis.window = { __TAURI__: { core: { invoke } } };
    const huge = { ...email, attachments: [{ ...inlineImage('logo'), size: 10 * 1024 * 1024 + 1 }] };

    const result = await hydrateInlineImages(huge, 'acct', 'INBOX');

    expect(invoke).not.toHaveBeenCalled();
    expect(result).toBe(huge);
  });

  it('keeps the images it could read when one read fails', async () => {
    globalThis.window = {
      __TAURI__: {
        core: {
          invoke: async (_cmd, { attachmentIndex }) => {
            if (attachmentIndex === 0) throw new Error('boom');
            return 'B';
          },
        },
      },
    };
    const two = { uid: 1, html: '<img src="cid:a"><img src="cid:b">', attachments: [inlineImage('a'), inlineImage('b')] };

    const result = await hydrateInlineImages(two, 'acct', 'INBOX');

    expect(result).not.toBe(two);
    expect(result.attachments[0].content).toBeUndefined();
    expect(result.attachments[1].content).toBe('B');
  });

  it('loads content only for cid-referenced attachments, by original index', async () => {
    const calls = [];
    globalThis.window = {
      __TAURI__: {
        core: {
          invoke: async (cmd, args) => {
            calls.push(args);
            return 'BASE64';
          },
        },
      },
    };

    const result = await hydrateInlineImages(email, 'acct', 'INBOX');

    expect(calls).toEqual([
      { accountId: 'acct', mailbox: 'INBOX', uid: 42, attachmentIndex: 1 },
    ]);
    expect(result.attachments[1].content).toBe('BASE64');
    expect(result.attachments[0].content).toBeUndefined();
    expect(result.attachments[2].content).toBeUndefined();
    expect(replaceCidUrls(result.html, result.attachments))
      .toBe('<img src="data:image/png;base64,BASE64"><img src="cid:unused">');
  });

  it('returns the same object when nothing is hydratable', async () => {
    globalThis.window = { __TAURI__: { core: { invoke: async () => 'X' } } };
    const plain = { uid: 1, html: '<p>hi</p>', attachments: [pdfAttachment] };
    expect(await hydrateInlineImages(plain, 'a', 'INBOX')).toBe(plain);
  });

  it('keeps the placeholder when the .eml read fails', async () => {
    globalThis.window = {
      __TAURI__: { core: { invoke: async () => { throw new Error('not found'); } } },
    };
    const result = await hydrateInlineImages(email, 'acct', 'INBOX');
    expect(result).toBe(email);
  });
});
