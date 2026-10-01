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
});
