// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';

const saver = vi.hoisted(() => ({ openInDefaultApp: vi.fn(async () => '/cache/x'), saveOneFile: vi.fn(async () => null) }));
vi.mock('../../services/export/exportSaver', () => saver);

import { imageFileFromSrc, openEmailImage, inlineImageAt, imageForDoubleClick } from '../emailImages';

const PNG = 'iVBORw0KGgo=';

describe('imageFileFromSrc', () => {
  it('turns an inline data: image into a file named by its type', () => {
    expect(imageFileFromSrc(`data:image/png;base64,${PNG}`)).toEqual({ name: 'image.png', base64: PNG });
  });

  it('names a jpeg .jpg and an svg .svg', () => {
    expect(imageFileFromSrc(`data:image/jpeg;base64,${PNG}`).name).toBe('image.jpg');
    expect(imageFileFromSrc(`data:image/svg+xml;base64,${PNG}`).name).toBe('image.svg');
  });

  it('takes the name of the attachment the image came from', () => {
    const attachments = [
      { filename: 'other.png', content: 'AAAA' },
      { filename: 'image001.png', content: `${PNG}\r\n` },
    ];
    expect(imageFileFromSrc(`data:image/png;base64,${PNG}`, attachments).name).toBe('image001.png');
  });

  it('never names a file outside the folder it is written to', () => {
    const attachments = [{ filename: '../../evil.png', content: PNG }];
    expect(imageFileFromSrc(`data:image/png;base64,${PNG}`, attachments).name).toBe('evil.png');
  });

  it('strips line breaks from the payload', () => {
    expect(imageFileFromSrc(`data:image/png;base64,iVBO\nRw0K`).base64).toBe('iVBORw0K');
  });

  it('offers nothing for a remote image: fetching it again would go around tracker blocking', () => {
    expect(imageFileFromSrc('https://example.com/a.png')).toBeNull();
  });

  it('offers nothing for a non-image or non-base64 data: URI', () => {
    expect(imageFileFromSrc(`data:text/html;base64,${PNG}`)).toBeNull();
    expect(imageFileFromSrc('data:image/svg+xml,%3Csvg%3E')).toBeNull();
    expect(imageFileFromSrc('')).toBeNull();
    expect(imageFileFromSrc(undefined)).toBeNull();
  });
});

describe('openEmailImage', () => {
  it('writes each open under its own name, so the viewer never shows a stale file at a reused path', async () => {
    const file = { name: 'image001.png', base64: PNG };
    await openEmailImage(file);
    await openEmailImage(file);
    const [a, b] = saver.openInDefaultApp.mock.calls.map(([f]) => f.name);
    expect(a).toMatch(/^image001-.+\.png$/);
    expect(b).toMatch(/^image001-.+\.png$/);
    expect(a).not.toBe(b);
    expect(saver.openInDefaultApp.mock.calls[0][0].base64).toBe(PNG);
  });
});

describe('inlineImageAt / imageForDoubleClick', () => {
  const body = (html) => {
    document.body.innerHTML = html;
    return document.body;
  };
  const src = `data:image/png;base64,${PNG}`;

  it('finds the inline image under the pointer', () => {
    const img = body(`<p><img src="${src}"></p>`).querySelector('img');
    expect(inlineImageAt(img)).toEqual({ name: 'image.png', base64: PNG });
    expect(imageForDoubleClick(img)).toEqual({ name: 'image.png', base64: PNG });
  });

  it('names it from the attachments it came from', () => {
    const img = body(`<img src="${src}">`).querySelector('img');
    expect(inlineImageAt(img, [{ filename: 'chart.png', content: PNG }]).name).toBe('chart.png');
  });

  it('finds nothing off an image, or on a remote one', () => {
    const root = body('<p>text</p><img src="https://example.com/a.png">');
    expect(inlineImageAt(root.querySelector('p'))).toBeNull();
    expect(inlineImageAt(root.querySelector('img'))).toBeNull();
    expect(inlineImageAt(null)).toBeNull();
  });

  it('a double click on a linked image is the link\'s, not a second open', () => {
    const img = body(`<a href="https://example.com"><img src="${src}"></a>`).querySelector('img');
    expect(imageForDoubleClick(img)).toBeNull();
    // The menu still offers it: a right click does not follow the link.
    expect(inlineImageAt(img)).not.toBeNull();
  });
});
