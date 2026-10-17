import { describe, expect, it } from 'vitest';
import { collect, keyOf, LOCALES, render, sourcePages, sourceHtml } from '../i18n/i18n.mjs';
import { tagMedia, validateMedia } from '../../scripts/website-media-policy.mjs';

const source = tagMedia('<img src="/screenshots/inbox-720.webp" alt="Inbox with saved mail">', [{ version: '2.16.0', assets: ['/screenshots/inbox'] }]).html;

describe('localized media versions', () => {
  it('translates descriptions independently of invariant version tags', () => {
    const dict = { [keyOf('Inbox with saved mail')]: 'Posteingang mit gespeicherten E-Mails' };
    const result = render(source, 'features.html', LOCALES[0], dict);
    expect(result).toContain('alt="Posteingang mit gespeicherten E-Mails · MailVault version 2.16.0"');
    expect(result).toContain('title="MailVault version 2.16.0"');
    expect(collect(source).map(item => item.text)).toEqual(['Inbox with saved mail']);
  });

  it('escapes quotes in translated accessible descriptions', () => {
    const result = render(source, 'features.html', LOCALES[0], { [keyOf('Inbox with saved mail')]: 'Posteingang mit "gespeicherten" E-Mails' });
    expect(result).toContain('alt="Posteingang mit &quot;gespeicherten&quot; E-Mails · MailVault version 2.16.0"');
  });

  it('keeps reviewed labels distinct from capture versions', () => {
    const html = tagMedia('<video aria-label="Archive mail"><source src="/assets/clips/en/archive.mp4"></video>', [{ version: '2.20.0', kind: 'reviewed', assets: ['/assets/clips/en/archive'] }]).html;
    const result = render(html, 'features.html', LOCALES[0], { [keyOf('Archive mail')]: 'E-Mails archivieren' });
    expect(result).toContain('aria-label="E-Mails archivieren · Reviewed for MailVault version 2.20.0"');
    expect(result).toContain('/assets/clips/de/archive.mp4');
  });

  it('requires descriptive accessible labels and evidence-backed versions on English media', () => {
    const errors = sourcePages().flatMap(file => validateMedia(sourceHtml(file)).map(error => `${file}: ${error}`));
    expect(errors).toEqual([]);
  });
});
