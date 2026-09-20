import { describe, expect, it } from 'vitest';
import { replyTemplateHtml } from '../replyTemplate';

describe('reply template insertion', () => {
  it('escapes template text and keeps line breaks before the separately quoted message', () => {
    expect(replyTemplateHtml('Hello <script>alert(1)</script>\nThanks & regards'))
      .toBe('<p>Hello &lt;script&gt;alert(1)&lt;/script&gt;</p><p>Thanks &amp; regards</p>');
  });

  it('keeps empty templates empty', () => {
    expect(replyTemplateHtml('')).toBe('');
  });
});
