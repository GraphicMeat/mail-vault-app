// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { setLocale } from '../../i18n/index.js';
import { classifyLink, scanEmailLinks } from '../linkSafety';
import { scanTrackers } from '../trackerDetect';

// The reasons a link or tracker is flagged were English template literals, so a
// German reader's "Dangerous Link Detected" dialog ended in an English sentence.
afterEach(async () => { await setLocale('en'); });

describe('link safety reasons follow the UI language', () => {
  it('names the three verdicts in German', async () => {
    await setLocale('de');
    expect(classifyLink('javascript:x()', 'go').reason).toBe('Der Link nutzt das gefährliche Schema javascript:');
    expect(classifyLink('https://evil.test/login', 'https://bank.test').reason)
      .toBe('Der Linktext zeigt bank.test, führt aber zu evil.test');
    expect(classifyLink('https://track.test/r?url=https%3A%2F%2Fother.test%2F', 'Offer').reason)
      .toBe('Der Link leitet über track.test zu other.test weiter');
  });

  it.each(['es', 'fr', 'it', 'ja', 'ko', 'pt-BR', 'zh-Hans'])('%s: no English left in the text-mismatch reason', async (code) => {
    await setLocale(code);
    const { reason } = classifyLink('https://evil.test/login', 'https://bank.test');
    expect(reason).toContain('bank.test');
    expect(reason).toContain('evil.test');
    expect(reason).not.toMatch(/Link text shows|but goes to/);
  });

  it('the tooltip title on the flagged link is in the UI language too', async () => {
    await setLocale('de');
    const { modifiedBodyHtml } = scanEmailLinks('<a href="https://evil.test/login">https://bank.test</a>', null);
    expect(modifiedBodyHtml).toContain('title="Der Linktext zeigt bank.test, führt aber zu evil.test"');
  });

  it('a language change is a different scan, not a cached English one', async () => {
    const body = '<a href="https://evil.test/login">https://bank.test</a>';
    const key = 'acct-1-INBOX-9';
    expect(scanEmailLinks(body, key).alerts[0].reason).toBe('Link text shows bank.test but goes to evil.test');
    await setLocale('de');
    expect(scanEmailLinks(body, key).alerts[0].reason).toBe('Der Linktext zeigt bank.test, führt aber zu evil.test');
  });
});

describe('tracker reasons follow the UI language', () => {
  it('a known vendor beacon and a path beacon, in German', async () => {
    await setLocale('de');
    const known = scanTrackers('<img src="https://example.list-manage.com/track/open.php?u=1" width="1" height="1">', null).trackers[0];
    expect(known.reason).not.toMatch(/open-tracking beacon/);
    expect(known.reason).toMatch(/Öffnungserkennung/);
    const path = scanTrackers('<img src="https://mail.unknown.test/pixel/abc123.gif">', null).trackers[0];
    expect(path.reason).toBe('Der Anfragepfad ist ein Endpunkt zur Öffnungserkennung');
  });
});
