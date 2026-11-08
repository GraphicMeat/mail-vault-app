import { describe, it, expect } from 'vitest';
import { hasAddressBody, hrefForUrl, isUrlStart, trimUrl } from '../linkUrls';

describe('linkUrls', () => {
  it('trims sentence punctuation and unopened closers', () => {
    expect(trimUrl('https://x.com/a.')).toBe('https://x.com/a');
    expect(trimUrl('https://x.com/a)')).toBe('https://x.com/a');
    expect(trimUrl('https://x.com/a_(b)')).toBe('https://x.com/a_(b)');
    expect(trimUrl('https://x.com/a?!.')).toBe('https://x.com/a');
  });
  it('knows an address body and a scheme start', () => {
    expect(hasAddressBody('www.')).toBe(false);
    expect(hasAddressBody('https://x')).toBe(true);
    expect(isUrlStart('WWW.x.com')).toBe(true);
    expect(isUrlStart('x@y.com')).toBe(false);
  });
  it('adds https to www links only', () => {
    expect(hrefForUrl('www.x.com')).toBe('https://www.x.com');
    expect(hrefForUrl('http://x.com')).toBe('http://x.com');
  });
});
