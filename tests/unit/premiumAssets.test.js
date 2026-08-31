import { describe, it, expect } from 'vitest';
import { existsSync, statSync } from 'node:fs';
import { PREMIUM_FEATURES } from '../../src/data/premiumFeatures.js';
import { shotUrl } from '../../src/components/onboarding/premiumShots.js';

const LOCALES = ['en', 'es', 'fr', 'it', 'de', 'pt-BR', 'ja', 'ko', 'zh-Hans'];

describe('bundled premium screenshots', () => {
  it('ships one 1440 webp per feature per locale', () => {
    for (const locale of LOCALES) {
      for (const f of PREMIUM_FEATURES) {
        if (!f.shot) continue;
        const p = `src/assets/premium/${locale}/${f.shot}-1440.webp`;
        expect(existsSync(p), `missing ${p}`).toBe(true);
        // A zero-length or near-empty file means the conversion failed silently.
        expect(statSync(p).size).toBeGreaterThan(4096);
      }
    }
  });
});

// The asset test above only proves the files exist on disk — it says nothing
// about whether `shotUrl()` can actually find them. Its lookup key is built
// from the *directory name*, and two of the nine (zh-Hans, pt-BR) don't match
// the website's own locale directories (zh, pt-br) that the files were pulled
// from. Get that mapping wrong and these two locales silently fall back to
// English forever, with the file-existence test above still green.
describe('shotUrl resolves the bundled files', () => {
  it('finds a real URL for zh-Hans, not just the English fallback', () => {
    const enUrl = shotUrl('premium-time-capsule', 'en');
    const zhUrl = shotUrl('premium-time-capsule', 'zh-Hans');
    expect(zhUrl).toBeTruthy();
    expect(zhUrl).not.toBe(enUrl);
  });

  it('finds a real URL for pt-BR, not just the English fallback', () => {
    const enUrl = shotUrl('premium-time-capsule', 'en');
    const ptUrl = shotUrl('premium-time-capsule', 'pt-BR');
    expect(ptUrl).toBeTruthy();
    expect(ptUrl).not.toBe(enUrl);
  });
});
