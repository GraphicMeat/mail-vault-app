import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assetKey, tagMedia, validateMedia, VERSION_SUFFIX } from './website-media-policy.mjs';

const capture = [{ version: '2.16.0', assets: ['/screenshots/inbox'] }];
const reviewed = [{ version: '2.20.0', kind: 'reviewed', assets: ['/assets/clips/en/archive'] }];

test('capture tags retain the description, responsive sources, and exact capture version', () => {
  const source = '<picture><source srcset="/screenshots/inbox-720.webp 720w"><img src="/screenshots/inbox-light-1440.webp" alt="Inbox with three archived messages"></picture>';
  const result = tagMedia(source, capture);
  assert.match(result.html, /alt="Inbox with three archived messages · MailVault version 2.16.0"/);
  assert.match(result.html, /data-mailvault-version-kind="capture"/);
  assert.ok(result.html.includes('<source srcset="/screenshots/inbox-720.webp 720w">'));
  assert.deepEqual(validateMedia(result.html, capture), []);
  assert.equal(tagMedia(result.html, capture).html, result.html);
});

test('review labels are explicit, with poster descriptions inherited from video', () => {
  const source = '<img class="mv-clip-poster" src="/assets/clips/en/archive-poster.jpg" alt=""><video aria-label="Archive messages and retain the local copy"><source src="/assets/clips/en/archive.mp4"></video>';
  const result = tagMedia(source, reviewed);
  assert.equal((result.html.match(/Reviewed for MailVault version 2.20.0/g) || []).length, 4);
  assert.match(result.html, /data-mailvault-version-kind="reviewed"/);
  assert.deepEqual(validateMedia(result.html, reviewed), []);
  assert.equal(tagMedia(result.html, reviewed).html, result.html);
  assert.equal('Archivierte Nachrichten · Reviewed for MailVault version 2.20.0'.replace(VERSION_SUFFIX, ''), 'Archivierte Nachrichten');
});

test('unverified assets never inherit the latest release', () => {
  const result = tagMedia('<img src="/screenshots/new-1440.webp" alt="A newly captured screen">', capture);
  assert.deepEqual(result.unresolved, ['/screenshots/new-1440.webp']);
  assert.ok(!result.html.includes('data-mailvault-version'));
  assert.ok(validateMedia(result.html, capture).some(error => error.includes('has not been verified')));
});

test('decorative branding, external product images, comments, and script strings stay untouched', () => {
  const source = '<img src="/icon-128.webp" alt=""><img src="/assets/blog/email-client-reviews/outlook.webp" alt="Outlook inbox"><script>const sample = \'<img src="/screenshots/inbox-720.webp">\';</script><!-- <img src="/screenshots/inbox-720.webp"> -->';
  assert.equal(tagMedia(source, capture).html, source);
  assert.deepEqual(validateMedia(source, capture), []);
});

test('localized variants resolve to the same version without rewriting URLs', () => {
  assert.equal(assetKey('/screenshots/ja/inbox-light-720.webp'), '/screenshots/inbox');
  assert.equal(assetKey('/assets/clips/fr/archive.light.mp4'), '/assets/clips/en/archive');
  const result = tagMedia('<img src="/screenshots/ja/inbox-light-720.webp" alt="受信トレイ">', capture);
  assert.ok(result.html.includes('src="/screenshots/ja/inbox-light-720.webp"'));
  assert.deepEqual(validateMedia(result.html, capture), []);
});

test('validation rejects missing descriptions, labels, and wrong versions', () => {
  assert.throws(() => tagMedia('<img src="/screenshots/inbox-720.webp" alt="">', capture), /Missing descriptive alt/);
  assert.ok(validateMedia('<img src="/icon-128.webp">', capture).some(error => error.includes('missing alt')));
  assert.ok(validateMedia('<video aria-label=""><source src="movie.mp4"></video>', capture).some(error => error.includes('descriptive accessible name')));
  const html = tagMedia('<img src="/screenshots/inbox-720.webp" alt="Inbox">', capture).html.replace('data-mailvault-version="2.16.0"', 'data-mailvault-version="2.20.0"');
  assert.ok(validateMedia(html, capture).some(error => error.includes('expected data-mailvault-version=2.16.0')));
});
