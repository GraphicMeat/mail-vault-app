import { describe, it, expect, beforeEach } from 'vitest';
import { parseMailto, openMailtoCompose, setMailtoComposeOpener } from '../mailto';

// The rule this file protects: a mailto: link in someone else's email is data,
// not a command. It prefills a compose window — it never navigates, never
// reaches the OS mail client, and never puts unescaped markup in the editor.

describe('parseMailto', () => {
  it('returns null for anything that is not a mailto: URI', () => {
    for (const href of ['https://example.com', 'cid:abc', 'tel:+370', '#anchor', '', null, undefined]) {
      expect(parseMailto(href)).toBeNull();
    }
  });

  it('reads the address out of the path', () => {
    expect(parseMailto('mailto:partners@blurb.com')).toMatchObject({
      to: 'partners@blurb.com', cc: '', bcc: '', subject: '', body: '',
    });
  });

  it('is case-insensitive on the scheme', () => {
    expect(parseMailto('MAILTO:a@b.com').to).toBe('a@b.com');
  });

  it('normalises a comma list of recipients', () => {
    expect(parseMailto('mailto:a@b.com,%20c@d.com ,, e@f.com').to).toBe('a@b.com, c@d.com, e@f.com');
  });

  it('keeps a literal + in an address', () => {
    // RFC 6068: '+' is not a space here. URLSearchParams would have eaten it.
    expect(parseMailto('mailto:rokas+lists@example.com').to).toBe('rokas+lists@example.com');
    expect(parseMailto('mailto:?to=rokas+lists@example.com').to).toBe('rokas+lists@example.com');
  });

  it('reads to/cc/bcc/subject/body out of the query', () => {
    const d = parseMailto('mailto:a@b.com?cc=c@d.com&bcc=e@f.com&subject=Ticket%202012599&body=Hello');
    expect(d).toMatchObject({ to: 'a@b.com', cc: 'c@d.com', bcc: 'e@f.com', subject: 'Ticket 2012599', body: 'Hello' });
  });

  it('appends a ?to= to the address in the path rather than replacing it', () => {
    expect(parseMailto('mailto:a@b.com?to=c@d.com').to).toBe('a@b.com, c@d.com');
  });

  it('ignores headers compose has no field for', () => {
    const d = parseMailto('mailto:a@b.com?in-reply-to=%3Cx%40y%3E&subject=Hi');
    expect(d.subject).toBe('Hi');
    expect(d).not.toHaveProperty('in-reply-to');
  });

  it('escapes the body and turns its newlines into HTML', () => {
    // `initialData.body` is loaded into the editor as HTML, so an <img onerror>
    // smuggled through a link in a stranger's email must arrive as text.
    const d = parseMailto('mailto:a@b.com?body=' + encodeURIComponent('<img src=x onerror=alert(1)>\nline two'));
    expect(d.body).toBe('&lt;img src=x onerror=alert(1)&gt;<br>line two');
  });

  it('leaves an empty body empty so compose can fall back to the signature', () => {
    expect(parseMailto('mailto:a@b.com').body).toBe('');
  });

  it('survives a malformed percent escape instead of throwing', () => {
    expect(parseMailto('mailto:a%zz@b.com').to).toBe('a%zz@b.com');
  });

  it('marks the result a fresh prefill, not a restored draft', () => {
    expect(parseMailto('mailto:a@b.com')._prefill).toBe(true);
  });

  it('carries the account the message arrived on, and only when there is one', () => {
    expect(parseMailto('mailto:a@b.com', 'acct-1')._accountId).toBe('acct-1');
    expect(parseMailto('mailto:a@b.com')).not.toHaveProperty('_accountId');
  });
});

describe('openMailtoCompose', () => {
  beforeEach(() => setMailtoComposeOpener(null));

  it('does nothing and reports it when no compose surface is mounted', () => {
    expect(openMailtoCompose('mailto:a@b.com')).toBe(false);
  });

  it('does not open compose for a link that is not a mailto:', () => {
    let opened = null;
    setMailtoComposeOpener(d => { opened = d; });
    expect(openMailtoCompose('https://example.com')).toBe(false);
    expect(opened).toBeNull();
  });

  it('hands the parsed prefill to the registered opener', () => {
    let opened = null;
    setMailtoComposeOpener(d => { opened = d; });
    expect(openMailtoCompose('mailto:a@b.com?subject=Hi', 'acct-2')).toBe(true);
    expect(opened).toMatchObject({ to: 'a@b.com', subject: 'Hi', _accountId: 'acct-2', _prefill: true });
  });
});
