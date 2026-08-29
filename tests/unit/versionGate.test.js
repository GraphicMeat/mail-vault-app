// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { compareVersions, applyToHomepage, applyToChangelog } =
  require('../../website/version-gate.js');

describe('compareVersions', () => {
  it('orders by number, not by string', () => {
    // The whole point: 2.9.2 must not sort above 2.10.0.
    expect(compareVersions('2.9.2', '2.10.0')).toBe(-1);
    expect(compareVersions('2.10.4', '2.10.3')).toBe(1);
    expect(compareVersions('2.10.3', '2.10.3')).toBe(0);
  });

  it('treats junk as 0.0.0 instead of NaN', () => {
    expect(compareVersions('', '0.0.1')).toBe(-1);
    expect(compareVersions('nightly', '0.0.0')).toBe(0);
  });
});

describe('applyToChangelog', () => {
  const page = (versions) =>
    versions
      .map(
        (v, i) => `<article data-version="${v}"><div class="hdr">${
          i === 0 ? '<span data-latest-badge>Latest</span>' : ''
        }</div></article>`
      )
      .join('');

  beforeEach(() => {
    document.body.innerHTML = page(['2.10.4', '2.10.3', '2.10.2']);
  });

  it('hides entries newer than the last published release', () => {
    applyToChangelog('2.10.3');
    const hidden = [...document.querySelectorAll('article')].map((a) => a.hidden);
    expect(hidden).toEqual([true, false, false]);
  });

  it('moves the Latest badge onto the published release', () => {
    applyToChangelog('2.10.3');
    const badge = document.querySelector('[data-latest-badge]');
    expect(badge.closest('article').dataset.version).toBe('2.10.3');
  });

  it('leaves the page alone once the newest version is published', () => {
    applyToChangelog('2.10.4');
    expect([...document.querySelectorAll('article')].some((a) => a.hidden)).toBe(false);
    expect(document.querySelector('[data-latest-badge]').closest('article').dataset.version)
      .toBe('2.10.4');
  });
});

describe('applyToHomepage', () => {
  const shipped = 'the 2.10.3 copy';
  beforeEach(() => {
    document.body.innerHTML =
      `<p data-whats-new data-version="2.10.3">${shipped}</p>`;
  });
  const para = () => document.querySelector('[data-whats-new]');

  it('swaps in the copy for a newer published version', () => {
    applyToHomepage('2.10.4', { '2.10.4': 'the 2.10.4 copy' });
    expect(para().textContent).toBe('the 2.10.4 copy');
    expect(para().dataset.version).toBe('2.10.4');
  });

  it('never moves backwards to an older release', () => {
    // A stale/rolled-back /api/latest-version must not rewrite shipped copy.
    applyToHomepage('2.10.2', { '2.10.2': 'the 2.10.2 copy' });
    expect(para().textContent).toBe(shipped);
  });

  it('keeps the shipped copy when the new version has no entry', () => {
    applyToHomepage('2.10.4', { '2.10.3': shipped });
    expect(para().textContent).toBe(shipped);
    expect(para().dataset.version).toBe('2.10.3');
  });

  it('leaves a localized page alone rather than pasting English over it', () => {
    // /whats-new.json only ever holds English. On /de/ the shipped copy is
    // already German, so the update has to be skipped, not applied.
    document.documentElement.setAttribute('lang', 'de');
    try {
      applyToHomepage('2.10.4', { '2.10.4': 'the 2.10.4 copy' });
      expect(para().textContent).toBe(shipped);
      expect(para().dataset.version).toBe('2.10.3');
    } finally {
      document.documentElement.setAttribute('lang', 'en');
    }
  });
});
