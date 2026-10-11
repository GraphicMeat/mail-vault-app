import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';

// The clips of the other site languages sit on the website host, outside git
// (website/assets/clips/<dir>/ is ignored; scripts/website-clips-upload.sh puts them there),
// so these checks only run where the files are present: after scripts/footage/site-set.py
// into that folder, or against a copy of the host's media. They check that every clip a
// locale page names exists, in the size classes the English ones are held to.
const LOCALES = ['de', 'fr', 'es', 'it', 'ja', 'ko', 'zh', 'pt-br'];
const jpegSize = (file) => {
  const b = readFileSync(file);
  for (let i = 2; i < b.length - 9;) {
    if (b[i] !== 0xff) { i++; continue; }
    const m = b[i + 1];
    if (m >= 0xc0 && m <= 0xc3) return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)];
    i += 2 + b.readUInt16BE(i + 2);
  }
  return [0, 0];
};
const named = (html) => [...new Set([...html.matchAll(/\/assets\/clips\/[a-z-]+\/([a-z0-9.-]+\.(?:mp4|jpg))/g)].map((m) => m[1]))];

describe.each(LOCALES)('%s clip files', (dir) => {
  const root = `website/assets/clips/${dir}`;
  const here = existsSync(root);
  const pages = ['index.html', ...readdirSync('website/features').filter((f) => f.endsWith('.html')).map((f) => `features/${f}`)];

  it.skipIf(!here)('has every file its pages name', () => {
    for (const rel of pages) {
      const html = readFileSync(`website/${dir}/${rel}`, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
      for (const f of named(html)) expect(existsSync(`${root}/${f}`), `${dir}/${rel}: ${f}`).toBe(true);
    }
  });

  it.skipIf(!here)('has a light twin for every card clip, the same size in pixels as the English one', () => {
    const cards = readdirSync('website/assets/clips/en').filter((f) => /^[a-z0-9-]+\.mp4$/.test(f) && f !== 'hero-montage.mp4').map((f) => f.replace('.mp4', ''));
    for (const clip of cards) {
      for (const f of [`${clip}.mp4`, `${clip}.light.mp4`, `${clip}.jpg`, `${clip}.light.jpg`, `${clip}-poster.jpg`, `${clip}-poster.light.jpg`]) expect(existsSync(`${root}/${f}`), `${dir}: ${f}`).toBe(true);
      expect(statSync(`${root}/${clip}.mp4`).size).toBeLessThan(260 * 1024);
      expect(statSync(`${root}/${clip}.light.mp4`).size).toBeLessThan(260 * 1024);
      expect(statSync(`${root}/${clip}-poster.jpg`).size).toBeLessThan(45 * 1024);
      expect(statSync(`${root}/${clip}-poster.light.jpg`).size).toBeLessThan(45 * 1024);
      expect(jpegSize(`${root}/${clip}-poster.jpg`)).toEqual(jpegSize(`website/assets/clips/en/${clip}-poster.jpg`));
      expect(jpegSize(`${root}/${clip}.jpg`)).toEqual(jpegSize(`website/assets/clips/en/${clip}.jpg`));
    }
  });

  it.skipIf(!here)('has the hero montage, dark only, at the English size', () => {
    expect(statSync(`${root}/hero-montage.mp4`).size).toBeLessThan(1.7 * 1024 * 1024);
    expect(jpegSize(`${root}/hero-montage.jpg`)).toEqual(jpegSize('website/assets/clips/en/hero-montage.jpg'));
  });
});
