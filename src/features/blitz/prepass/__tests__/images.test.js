// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { stampImages, imageSrcAt } from '../images';
import { runPrepass } from '../index';

const parse = (html) => new DOMParser().parseFromString(html, 'text/html');

describe('stampImages', () => {
  it('numbers every <img> in document order, nested ones included', () => {
    const doc = parse('<img src="a"><table><tr><td><img src="b"></td></tr></table><p><a href="x"><img src="c"></a></p>');
    stampImages(doc);
    expect([...doc.querySelectorAll('img')].map(i => i.getAttribute('data-mv-img'))).toEqual(['0', '1', '2']);
  });

  it('overwrites a number the mail wrote itself', () => {
    const doc = parse('<img data-mv-img="9" src="a">');
    stampImages(doc);
    expect(doc.querySelector('img').getAttribute('data-mv-img')).toBe('0');
  });
});

describe('imageSrcAt', () => {
  const html = '<img src="data:image/png;base64,AAAA" data-mv-img="0"><img src="https://x.example/b.jpg" data-mv-img="1">';
  it('finds the src of the stamped image', () => {
    expect(imageSrcAt(html, '0')).toBe('data:image/png;base64,AAAA');
    expect(imageSrcAt(html, '1')).toBe('https://x.example/b.jpg');
  });
  it('answers null for an id that is not a number or not there', () => {
    expect(imageSrcAt(html, '7')).toBeNull();
    expect(imageSrcAt(html, '0"],[x="')).toBeNull();
    expect(imageSrcAt(null, '0')).toBeNull();
  });
});

describe('runPrepass', () => {
  it('stamps the images in the HTML the worker gets', async () => {
    const { html } = await runPrepass({ bodyHtml: '<p>x</p><img src="https://x.example/a.png"><img src="https://x.example/b.png">', theme: { dark: false } });
    expect(imageSrcAt(html, '1')).toBe('https://x.example/b.png');
  });
});
