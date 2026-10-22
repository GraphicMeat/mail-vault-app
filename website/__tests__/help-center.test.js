import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { LOCALES, render, keyOf } from '../i18n/i18n.mjs';
import { tagMedia, validateMedia } from '../../scripts/website-media-policy.mjs';

describe('help center navigation', () => {
  it('makes FAQ, guides and articles available from one accessible directory', () => {
    const document = new JSDOM(readFileSync('website/docs.html', 'utf8')).window.document;
    const navigation = document.querySelector('.mv-help-sidebar nav');
    expect(navigation, 'shared topic navigation').not.toBeNull();
    for (const href of ['/faq/getting-started.html', '/faq/storage-and-vault.html', '/docs.html#guides', '/docs.html#articles']) {
      expect(navigation.querySelector(`a[href="${href}"]`), href).not.toBeNull();
    }
    expect(document.querySelector('#help-directory a[href="/blog/find-emails-you-havent-replied-to.html"]')).not.toBeNull();
    expect(document.querySelector('#help-directory a[href="/guides/backup-gmail-to-eml.html"]')).not.toBeNull();
  });

  it('localizes help recordings, tracks and capture language without translating provenance', () => {
    const html = '<video data-mailvault-version="2.20.0" data-mailvault-version-kind="capture" aria-label="Search saved email · MailVault version 2.20.0 en" poster="/assets/help-media/en/search-local.jpg"><source src="/assets/help-media/en/search-local.mp4"><track src="/assets/help-media/en/search-local.vtt" srclang="en" label="English"></video>';
    const out = render(html, 'docs.html', LOCALES[0], { [keyOf('Search saved email')]: 'Gespeicherte E-Mails durchsuchen' });
    const video = new JSDOM(out).window.document.querySelector('video');
    expect(video.getAttribute('aria-label')).toBe('Gespeicherte E-Mails durchsuchen · MailVault version 2.20.0 de');
    expect(video.querySelector('source').src).toBe('/assets/help-media/de/search-local.mp4');
    expect(video.querySelector('track').src).toBe('/assets/help-media/de/search-local.vtt');
    expect(video.querySelector('track').srclang).toBe('de');
  });

  it('preserves the verified capture language when tagging new help screenshots', () => {
    const records = [{ version:'2.20.0', locale:'en', assets:['/assets/help-media/en/search-local'] }];
    const out = tagMedia('<img src="/assets/help-media/en/search-local.webp" alt="Search saved email">', records).html;
    expect(new JSDOM(out).window.document.querySelector('img').alt).toBe('Search saved email · MailVault version 2.20.0 en');
    expect(validateMedia(out, records)).toEqual([]);
  });

  it('shows the search controls only when the search script is available', () => {
    const dom = new JSDOM(readFileSync('website/docs.html','utf8'), { runScripts:'outside-only' });
    const search = dom.window.document.querySelector('.mv-help-search');
    expect(search.hidden).toBe(true);
    dom.window.eval(readFileSync('website/search.js','utf8'));
    expect(search.hidden).toBe(false);
  });

  it('keeps bookmarked guide and comparison fragment destinations', () => {
    for (const [file,fragment] of [['docs.html','backup-guides'],['blog.html','backup-guides'],['blog.html','email-client-series']]) {
      const document = new JSDOM(readFileSync('website/'+file,'utf8')).window.document;
      expect(document.getElementById(fragment), `${file}#${fragment}`).not.toBeNull();
    }
  });

  it('shows workflow demonstrations only on relevant help pages', () => {
    for (const file of ['faq/scheduled-send.html','blog/email-templates-for-client-replies.html']) {
      const document = new JSDOM(readFileSync('website/'+file,'utf8')).window.document;
      expect(!!document.querySelector('.mv-help-demo'), file).toBe(false);
    }
    const document = new JSDOM(readFileSync('website/faq/backup-and-restore.html','utf8')).window.document;
    expect(document.querySelector('.mv-help-demo video source')?.getAttribute('src')).toBe('/assets/help-media/en/manual-backup.mp4');
  });
});
