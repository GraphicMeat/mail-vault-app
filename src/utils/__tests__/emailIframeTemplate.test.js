import { describe, it, expect } from 'vitest';
import { getEmailBodyContent, measureEmailIframeHeight } from '../emailIframeTemplate';

describe('getEmailBodyContent', () => {
  it('unwraps a real document', () => {
    const html = '<!DOCTYPE html><html><head></head><body><p>hi</p></body></html>';
    expect(getEmailBodyContent(html)).toBe('<p>hi</p>');
  });

  it('keeps the sender text when the quote embeds a whole document', () => {
    // Our own reply: fragment + <blockquote> holding Proton's full document.
    const html = '<p>Hello again</p><hr><blockquote><html><head></head><body>That would be awesome.</body></html></blockquote>';
    expect(getEmailBodyContent(html)).toContain('Hello again');
  });

  it('does not truncate a document at a nested </body>', () => {
    const html = '<html><body><p>mine</p><blockquote><body>quoted</body></blockquote><p>tail</p></body></html>';
    const out = getEmailBodyContent(html);
    expect(out).toContain('mine');
    expect(out).toContain('tail');
  });

  it('passes fragments through', () => {
    expect(getEmailBodyContent('<p>plain</p>')).toBe('<p>plain</p>');
    expect(getEmailBodyContent('')).toBe('');
  });
});

describe('measureEmailIframeHeight', () => {
  // Fake doc: body height is content-driven, documentElement never reports
  // less than the frame viewport — the old max() over both ratcheted.
  const fakeDoc = (contentHeight, frameHeight) => ({
    body: {
      scrollHeight: contentHeight,
      offsetHeight: contentHeight,
      getBoundingClientRect: () => ({ height: contentHeight }),
    },
    documentElement: {
      scrollHeight: Math.max(contentHeight, frameHeight),
      offsetHeight: Math.max(contentHeight, frameHeight),
    },
  });

  it('ignores the frame viewport so re-measuring is stable', () => {
    const doc = fakeDoc(220, 150);
    const first = measureEmailIframeHeight(doc);
    expect(first).toBe(220);
    // Frame is now taller than the content; a second pass must not grow.
    expect(measureEmailIframeHeight(fakeDoc(220, first + 8))).toBe(220);
  });

  it('shrinks when content collapses (quote fold)', () => {
    expect(measureEmailIframeHeight(fakeDoc(120, 800))).toBe(120);
  });

  it('returns 0 for a missing document or body', () => {
    expect(measureEmailIframeHeight(null)).toBe(0);
    expect(measureEmailIframeHeight({})).toBe(0);
  });
});
