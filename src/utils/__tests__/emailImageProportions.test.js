// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { keepImageProportions, buildEmailIframeHtml } from '../emailIframeTemplate';

// The style attribute of the first <img> in `html`, as the browser reads it.
const imgStyle = (html) => {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  return doc.querySelector('img').getAttribute('style') ?? '';
};
const decl = (style, prop) => {
  const hit = style.split(';').map(d => d.split(':')).find(([k]) => k.trim().toLowerCase() === prop);
  return hit ? hit.slice(1).join(':').trim() : undefined;
};

describe('keepImageProportions', () => {
  // The Outlook / Power BI paste: a screenshot sized in inches by inline style.
  // `max-width:100%` clamps the width, the inline height outranks the frame's
  // `height:auto`, and the picture is squashed sideways.
  const outlook = '<img width="1234" height="567" src="cid:image001.png" style="width:12.85in;height:5.9in">';

  it('lets a clamped inline-sized image keep its shape', () => {
    const style = imgStyle(keepImageProportions(outlook));
    expect(decl(style, 'height')).toBe('auto');
    expect(decl(style, 'width')).toBe('12.85in');
    expect(decl(style, 'aspect-ratio')).toMatch(/^1233\.6\d* \/ 566\.4\d*$/);
  });

  it('takes the width from the attribute when the style sizes only the height', () => {
    const style = imgStyle(keepImageProportions('<img src="x.png" width="600" style="height:300px;border:0">'));
    expect(decl(style, 'height')).toBe('auto');
    expect(decl(style, 'aspect-ratio')).toBe('600 / 300');
    expect(decl(style, 'border')).toBe('0');
  });

  it('leaves a logo sized only by its inline height alone', () => {
    const html = '<img src="logo.png" style="height:40px">';
    expect(keepImageProportions(html)).toBe(html);
  });

  it('leaves an image sized only by attributes alone (the frame CSS already handles it)', () => {
    const html = '<img src="a.png" width="1900" height="1100">';
    expect(keepImageProportions(html)).toBe(html);
  });

  it('leaves a relative width alone: there is no ratio to keep', () => {
    const html = '<img src="a.png" style="width:100%;height:200px">';
    expect(keepImageProportions(html)).toBe(html);
  });

  it('does not read line-height or max-height as the height', () => {
    const html = '<img src="a.png" style="width:300px;line-height:20px;max-height:50px">';
    expect(keepImageProportions(html)).toBe(html);
  });

  it('leaves height:auto alone', () => {
    const html = '<img src="a.png" style="width:300px;height:auto">';
    expect(keepImageProportions(html)).toBe(html);
  });

  it('handles single-quoted styles and upper-case tags', () => {
    const style = imgStyle(keepImageProportions("<IMG SRC='a.png' STYLE='WIDTH: 200px; HEIGHT: 100px'>"));
    expect(decl(style, 'height')).toBe('auto');
    expect(decl(style, 'aspect-ratio')).toBe('200 / 100');
  });

  it('touches nothing but img tags', () => {
    const html = '<div style="width:300px;height:100px">x</div>';
    expect(keepImageProportions(html)).toBe(html);
  });
});

describe('buildEmailIframeHtml image proportions', () => {
  it('reshapes an inline-sized image in the frame it builds', () => {
    const html = buildEmailIframeHtml({ bodyHtml: '<p><img src="a.png" style="width:900px;height:450px"></p>' });
    const body = html.slice(html.indexOf('<body>'));
    expect(decl(imgStyle(body), 'height')).toBe('auto');
    expect(decl(imgStyle(body), 'aspect-ratio')).toBe('900 / 450');
  });
});
