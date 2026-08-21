// @vitest-environment jsdom

// Gmail and Outlook.com strip `data:` image sources, so an inline picture that
// leaves compose as a data URI simply never renders for the recipient. This
// pins the conversion the send path depends on: the <img> must end up pointing
// at a cid: that an emitted MIME part actually carries.
import { describe, it, expect } from 'vitest';
import { extractInlineImages } from '../inlineImages';

const PNG = 'iVBORw0KGgo=';

describe('extractInlineImages', () => {
  it('rewrites the src to cid: and returns the matching part', () => {
    const { html, attachments } = extractInlineImages(
      `<p>hi</p><img src="data:image/png;base64,${PNG}" alt="cat.png">`
    );

    expect(attachments).toHaveLength(1);
    const [att] = attachments;
    expect(att.contentType).toBe('image/png');
    expect(att.content).toBe(PNG);           // bare payload, no data: prefix
    expect(att.cid).toMatch(/@mailvault\.inline$/);
    expect(att.cid).not.toMatch(/[<>]/);     // the MIME builder adds the brackets
    expect(html).toContain(`src="cid:${att.cid}"`);
    expect(html).not.toContain('data:image/png');
  });

  it('gives the same image dropped twice one cid and one part', () => {
    const img = `<img src="data:image/png;base64,${PNG}" alt="cat.png">`;
    const { html, attachments } = extractInlineImages(img + '<p>x</p>' + img);

    expect(attachments).toHaveLength(1);
    expect(html.match(new RegExp(`cid:${attachments[0].cid}`, 'g'))).toHaveLength(2);
  });

  it('returns the original html string untouched when nothing matches', () => {
    const html = '<p>hi</p><img src="https://example.com/cat.png">';
    const result = extractInlineImages(html);

    expect(result.html).toBe(html);          // same string, not re-serialised
    expect(result.attachments).toEqual([]);
  });

  it('names the part from alt, and falls back to the mime subtype', () => {
    const named = extractInlineImages(`<img src="data:image/png;base64,${PNG}" alt="receipt.png">`);
    expect(named.attachments[0].filename).toBe('receipt.png');

    const unnamed = extractInlineImages(`<img src="data:image/jpeg;base64,${PNG}">`);
    expect(unnamed.attachments[0].filename).toBe('inline-1.jpg');
  });
});
