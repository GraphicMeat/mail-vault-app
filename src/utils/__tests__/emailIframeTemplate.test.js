import { describe, it, expect } from 'vitest';
import {
  getEmailBodyContent,
  measureEmailIframeHeight,
  stripInlineColorImportant,
  buildEmailIframeHtml,
} from '../emailIframeTemplate';

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

describe('stripInlineColorImportant', () => {
  it('drops the priority from colour declarations', () => {
    // The newsletter shape that rendered black-on-black in dark mode.
    const html = '<h2 style="color:hsl(0, 0%, 0%) !important; font-size:1.3em !important;">Hi</h2>';
    const out = stripInlineColorImportant(html);
    expect(out).toContain('color:hsl(0, 0%, 0%);');
    expect(out).toContain('font-size:1.3em !important;');
  });

  it('covers the other colour properties Dark Reader overrides', () => {
    const html = '<td style="background-color:#fff !important;border-top-color:#ccc !important;'
      + 'background:#eee !important;fill:#000 !important;outline-color:red !important">x</td>';
    const out = stripInlineColorImportant(html);
    expect(out).not.toContain('!important');
  });

  it('leaves layout and typography priorities alone', () => {
    const html = '<div style="width:100% !important;padding:0 !important;display:block !important">x</div>';
    expect(stripInlineColorImportant(html)).toBe(html);
  });

  it('handles single-quoted style attributes and last declarations', () => {
    const html = "<p style='margin:0 !important;color:#000 !important'>x</p>";
    expect(stripInlineColorImportant(html)).toBe("<p style='margin:0 !important;color:#000'>x</p>");
  });

  it('passes through bodies with nothing to strip', () => {
    const html = '<p style="color:#000">x</p><p>plain</p>';
    expect(stripInlineColorImportant(html)).toBe(html);
    expect(stripInlineColorImportant('')).toBe('');
  });
});

describe('buildEmailIframeHtml colour priorities', () => {
  const body = '<h2 style="color:#000 !important">Hi</h2>';

  it('strips them when Dark Reader will run', () => {
    expect(buildEmailIframeHtml({ bodyHtml: body, themeTag: 'dark' }))
      .toContain('style="color:#000"');
  });

  it('leaves the body untouched in light mode', () => {
    expect(buildEmailIframeHtml({ bodyHtml: body, themeTag: 'light' })).toContain(body);
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
