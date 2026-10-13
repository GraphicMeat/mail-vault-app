// The blitz.* strings follow each locale's own conventions for the rest of the catalog.
import { describe, it, expect } from 'vitest';
import fr from '../../../i18n/locales/fr.json';
import ja from '../../../i18n/locales/ja.json';
import zh from '../../../i18n/locales/zh-Hans.json';

const blitz = (cat) => Object.entries(cat).filter(([k]) => k.startsWith('blitz.'));
const CJK = '[\\u3040-\\u30ff\\u4e00-\\u9fff]';

describe('blitz.* wording', () => {
  it('fr addresses the reader with vous, like the rest of the catalog', () => {
    for (const [k, v] of blitz(fr)) expect(v, k).not.toContain('Désactive-le');
    expect(fr['blitz.settings.description']).toContain('Désactivez-le');
  });
  it('ja uses full-width parentheses and spaces Latin words from Japanese text', () => {
    for (const [k, v] of blitz(ja)) {
      expect(v, k).not.toMatch(/[()]/);
      expect(v, k).not.toMatch(new RegExp(`${CJK}[A-Za-z]|[A-Za-z]${CJK}`));
    }
    expect(ja['blitz.settings.title']).toBe('Rust レンダラー（試験的）');
  });
  it('zh-Hans uses full-width commas and parentheses', () => {
    for (const [k, v] of blitz(zh)) {
      expect(v, k).not.toMatch(/[(),]/);
    }
    expect(zh['blitz.settings.title']).toBe('Rust 渲染器（实验性）');
  });
  it('no locale uses an em dash', () => {
    for (const cat of [fr, ja, zh]) for (const [k, v] of blitz(cat)) expect(v, k).not.toContain('—');
  });
});
