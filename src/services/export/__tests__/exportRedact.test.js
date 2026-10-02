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

  describe('reveal (a spam sender stays readable)', () => {
    const spam = {
      ...FIXTURE_MESSAGE,
      from: { name: 'Prize Desk', address: 'win@prize.example' },
      replyTo: [{ name: 'Collect', address: 'collect@elsewhere.example' }],
    };
    const reveal = new Set(['win@prize.example', 'prize desk', 'collect@elsewhere.example']);

    it('leaves the From and Reply-To values in the set alone, and masks everyone else', () => {
      const m = redactMessageForExport(spam, dict, { reveal });
      expect(m.from).toEqual({ name: 'Prize Desk', address: 'win@prize.example' });
      expect(m.replyTo[0].address).toBe('collect@elsewhere.example');
      expect(m.replyTo[0].name).toBe('xxxxxxx'); // not in the set
      noLeak(JSON.stringify(m.to) + JSON.stringify(m.cc));
      expect(m.to[0].address).toBe('xxxxx@xxxxxxx.xx');
    });

    it('is exact: a different address or only the name in the set reveals only that', () => {
      const m = redactMessageForExport(spam, dict, { reveal: new Set(['prize desk', 'win@prize.example.org']) });
      expect(m.from.name).toBe('Prize Desk');
      expect(m.from.address).toBe('xxx@xxxxx.xxxxxxx');
    });

    it('never reveals a recipient, even one whose value is in the set', () => {
      const m = redactMessageForExport({ ...spam, to: [{ name: 'Rokas Ambrazevičius', address: 'win@prize.example' }] }, dict, { reveal });
      expect(m.to[0].address).toBe('xxx@xxxxx.xxxxxxx');
    });

    it('takes the set from the dictionary when none is passed, and masks without one', () => {
      expect(redactMessageForExport(spam, { ...dict, reveal }).from.address).toBe('win@prize.example');
      expect(redactMessageForExport(spam, dict).from.address).toBe('xxx@xxxxx.xxxxxxx');
    });

    it('a subject that names the revealed address shows it, the contact\'s name still masked', () => {
      const m = redactMessageForExport({ ...spam, subject: 'Re: win@prize.example for Joanna Kowalczyk' }, { ...dict, reveal });
      expect(m.subject).toBe('Re: win@prize.example for xxxxxx xxxxxxxxx');
    });
  });
});
