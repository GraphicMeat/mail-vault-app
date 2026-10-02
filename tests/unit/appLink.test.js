import { describe, it, expect } from 'vitest';
import { appLink } from '../../src/services/appLink.js';
import { faqUrl } from '../../src/services/faqUrl.js';

describe('appLink', () => {
  it('tags a page opened from the app, keeping the anchor last', () => {
    expect(appLink('https://mailvaultapp.com/faq.html#proton-mail-bridge', 'account_setup'))
      .toBe('https://mailvaultapp.com/faq.html?utm_source=app&utm_medium=account_setup#proton-mail-bridge');
    expect(appLink('https://mailvaultapp.com/', 'help_settings')).toBe('https://mailvaultapp.com/?utm_source=app&utm_medium=help_settings');
    expect(appLink('https://mailvaultapp.com/pricing.html?plan=yearly', 'x')).toBe('https://mailvaultapp.com/pricing.html?plan=yearly&utm_source=app&utm_medium=x');
  });

  it('tags the FAQ only when told where it was opened from', () => {
    expect(faqUrl('de')).toBe('https://mailvaultapp.com/de/faq.html');
    expect(faqUrl('de', 'bug_report')).toBe('https://mailvaultapp.com/de/faq.html?utm_source=app&utm_medium=bug_report');
  });
});
