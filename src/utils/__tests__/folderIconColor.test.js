import { describe, it, expect } from 'vitest';
import {
  FOLDER_ICON_PALETTE, defaultFolderColor, folderIconColor, folderColorKey,
  normalizeFolderIconStyle, normalizeFolderIconColors,
} from '../folderIconColor';

const box = (extra = {}) => ({ path: 'Projects', specialUse: null, ...extra });

describe('defaultFolderColor', () => {
  it('gives each special folder its own colour', () => {
    const roles = ['INBOX', '\\Sent', '\\Drafts', '\\Trash', '\\Junk', '\\Starred', '\\Important', '\\Archive'];
    const colors = roles.map(r => defaultFolderColor(box(r === 'INBOX' ? { path: r } : { specialUse: r })));
    expect(colors.every(c => /^#[0-9a-f]{6}$/i.test(c))).toBe(true);
    expect(new Set(colors).size).toBeGreaterThanOrEqual(7);
  });

  it('colours a plain folder, a local folder and an unknown one', () => {
    expect(defaultFolderColor(box())).toMatch(/^#/);
    expect(defaultFolderColor(box({ local: true }))).toMatch(/^#/);
    expect(defaultFolderColor(box({ local: true }))).not.toBe(defaultFolderColor(box()));
  });
});

describe('folderIconColor', () => {
  const key = folderColorKey('acc1', 'Projects');

  it('colourful style: role colour, custom colour wins', () => {
    expect(folderIconColor(box(), { style: 'colorful', colors: {}, accountId: 'acc1' }))
      .toBe(defaultFolderColor(box()));
    expect(folderIconColor(box(), { style: 'colorful', colors: { [key]: '#112233' }, accountId: 'acc1' }))
      .toBe('#112233');
  });

  it('theme style: one accent colour for every folder', () => {
    const a = folderIconColor(box(), { style: 'theme', colors: {}, accountId: 'acc1' });
    const b = folderIconColor(box({ specialUse: '\\Trash' }), { style: 'theme', colors: {}, accountId: 'acc1' });
    expect(a).toBe('var(--mail-accent-text)');
    expect(b).toBe(a);
  });

  it('a custom colour beats the theme style too', () => {
    expect(folderIconColor(box(), { style: 'theme', colors: { [key]: '#112233' }, accountId: 'acc1' }))
      .toBe('#112233');
  });

  it('a custom colour is per account', () => {
    expect(folderIconColor(box(), { style: 'colorful', colors: { [key]: '#112233' }, accountId: 'acc2' }))
      .toBe(defaultFolderColor(box()));
  });
});

describe('normalizers', () => {
  it('style falls back to colorful', () => {
    expect(normalizeFolderIconStyle('theme')).toBe('theme');
    expect(normalizeFolderIconStyle('colorful')).toBe('colorful');
    expect(normalizeFolderIconStyle('x')).toBe('colorful');
    expect(normalizeFolderIconStyle(undefined)).toBe('colorful');
  });

  it('colours keep only valid hex values', () => {
    expect(normalizeFolderIconColors({ a: '#AABBCC', b: 'red', c: 5, d: '#abc' }))
      .toEqual({ a: '#aabbcc' });
    expect(normalizeFolderIconColors(null)).toEqual({});
    expect(normalizeFolderIconColors([1])).toEqual({});
  });

  it('palette is valid hex, no duplicates', () => {
    expect(FOLDER_ICON_PALETTE.every(c => /^#[0-9a-f]{6}$/.test(c))).toBe(true);
    expect(new Set(FOLDER_ICON_PALETTE).size).toBe(FOLDER_ICON_PALETTE.length);
  });
});
