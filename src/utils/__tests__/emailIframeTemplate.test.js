import { describe, it, expect } from 'vitest';
import { getEmailBodyContent } from '../emailIframeTemplate';

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
