// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { buildNameDictionary } from '../../../utils/privacy/piiDetector';
import { redactMessageForExport, redactBodyForExport } from '../exportRedact';
import { PEOPLE, FIXTURE_MESSAGE, NEEDLES } from '../../../test/privacyFixtures';

const dict = buildNameDictionary({ names: PEOPLE.names });
const noLeak = (s) => NEEDLES.forEach(n => expect(s, n).not.toContain(n));

const BODY = `<div style="display:none">Preheader for Joanna Kowalczyk</div>
<p>Hi Rokas Ambrazevičius, call +370 612 34567</p>
<a href="https://track.example/c?e=am9hbm5hLmtAZXhhbXBsZS5vcmc=&to=joanna.k%40example.org">link</a>
<img src="https://img.example/p.png?u=joanna.k@example.org"><img src="data:image/png;base64,AAAA" alt="Joanna Kowalczyk">`;

describe('export redaction', () => {
  it('message headers, subject, ids and attachment names', () => {
    const m = redactMessageForExport({ ...FIXTURE_MESSAGE, messageId: '<abc@example.org>' }, dict);
    noLeak(JSON.stringify(m));
    expect(m.messageId).toBe('xxxx');
    expect(m.attachments[0].filename).toBe('attachment-1.pdf');
    expect(FIXTURE_MESSAGE.from.name).toBe('Joanna Kowalczyk'); // input untouched
  });
  it('image body: masked spans, hidden preheader too', () => {
    const out = redactBodyForExport(BODY, dict, { format: 'image' });
    noLeak(out);
    expect(out).toContain('class="mv-pii"');
    expect(out).not.toMatch(/href=/);
  });
  it('html body: no hrefs, no remote images, bars instead of spans', () => {
    const out = redactBodyForExport(BODY, dict, { format: 'html' });
    noLeak(out);
    expect(out).not.toMatch(/href=/);
    expect(out).not.toContain('img.example');
    expect(out).toContain('data:image/png');
    expect(out).toContain('█');
    expect(out).not.toContain('mv-pii');
  });

  it('drops comments, including Outlook conditional blocks, and template content', () => {
    const out = redactBodyForExport(`<!-- for joanna.k@example.org --><!--[if mso]><p>Joanna Kowalczyk</p><![endif]-->
      <template><p>Call +370 612 34567</p></template><p>kept</p>`, dict, { format: 'html' });
    noLeak(out);
    expect(out).not.toContain('<!--');
    expect(out).not.toContain('<template');
    expect(out).toContain('kept');
  });
  it('drops any other attribute that names someone (data-*, action, meta content), keeping masked title/alt', () => {
    const out = redactBodyForExport(`<div data-email="joanna.k@example.org" data-user="Joanna%20Kowalczyk" data-n="7">x</div>
      <form action="https://x.example/u?to=owen%40own.example"></form><meta content="Rokas Ambrazevičius">
      <span title="Joanna Kowalczyk">t</span>`, dict, { format: 'html' });
    noLeak(out);
    expect(out).toContain('data-n="7"');
    expect(out).toMatch(/title="x+ x+"/);
  });
  it('drops remote background, poster and srcset URLs, keeps data: ones', () => {
    const out = redactBodyForExport(`<table background="https://img.example/bg.png?u=joanna.k@example.org"><tr><td background="data:image/png;base64,AAAA">a</td></tr></table>
      <video poster="https://img.example/p.png"></video><picture><source srcset="https://img.example/s.png 2x"><img src="data:image/png;base64,BBBB"></picture>`, dict, { format: 'image' });
    noLeak(out);
    expect(out).not.toContain('img.example');
    expect(out).toContain('background="data:image/png;base64,AAAA"');
    expect(out).toContain('data:image/png;base64,BBBB');
  });
  it('strips remote url() from inline styles and <style> text, keeps data: ones', () => {
    const out = redactBodyForExport(`<style>.h{background:url(https://img.example/h.png?e=joanna.k@example.org)} .d{background:url("data:image/png;base64,CCCC")}</style>
      <div style="background-image:url('https://img.example/i.png')">a</div>`, dict, { format: 'image' });
    noLeak(out);
    expect(out).not.toContain('img.example');
    expect(out).toContain('data:image/png;base64,CCCC');
  });
});
