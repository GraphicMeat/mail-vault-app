import { describe, expect, it } from 'vitest';
import {
  GOOGLE_FONTS, GOOGLE_FONT_CATEGORIES, findGoogleFont, googleFontId, googleFamilyOf, uiFontStack,
  emailFontStack, searchGoogleFonts,
} from '../googleFonts';
import { SIGNATURE_FONTS, signatureFontStack } from '../signatureFonts';
import { APP_FONTS } from '../appFont';

describe('Google Fonts catalogue', () => {
  it('lists about a hundred families, each in a known category', () => {
    expect(GOOGLE_FONTS.length).toBeGreaterThanOrEqual(90);
    for (const font of GOOGLE_FONTS) expect(GOOGLE_FONT_CATEGORIES, font.family).toContain(font.category);
  });

  // The same name as a bundled @font-face would leave which face draws up to
  // the browser.
  it('never repeats a family the app bundles', () => {
    const bundled = APP_FONTS.map(font => font.family).filter(Boolean);
    expect(GOOGLE_FONTS.filter(font => bundled.includes(font.family)).map(font => font.family)).toEqual([]);
  });

  it('finds a family by its exact name, as an id', () => {
    expect(findGoogleFont('Roboto')?.category).toBe('sans');
    expect(findGoogleFont('roboto')).toBeNull();
    expect(googleFontId('Open Sans')).toBe('google:Open Sans');
    expect(googleFamilyOf('google:Open Sans')).toBe('Open Sans');
    expect(googleFamilyOf('inter')).toBeNull();
    expect(googleFamilyOf(undefined)).toBeNull();
  });

  it('searches by name within a category', () => {
    expect(searchGoogleFonts('rob').map(font => font.family)).toEqual(expect.arrayContaining(['Roboto', 'Roboto Mono', 'Roboto Slab']));
    expect(searchGoogleFonts('rob', 'mono').map(font => font.family)).toEqual(['Roboto Mono']);
    expect(searchGoogleFonts('', 'handwriting').every(font => font.category === 'handwriting')).toBe(true);
    expect(searchGoogleFonts('  ').length).toBe(GOOGLE_FONTS.length);
  });

  it('falls back by category: the UI to system faces, a signature to faces every mail client has', () => {
    expect(uiFontStack('Roboto')).toBe("'Roboto', system-ui, sans-serif");
    expect(uiFontStack('Lora')).toBe("'Lora', Georgia, serif");
    expect(uiFontStack('Roboto Mono')).toBe("'Roboto Mono', ui-monospace, monospace");
    expect(emailFontStack('Roboto')).toBe("Roboto, Arial, Helvetica, sans-serif");
    expect(emailFontStack('Open Sans')).toBe("'Open Sans', Arial, Helvetica, sans-serif");
    expect(emailFontStack('Lora')).toBe("Lora, Georgia, 'Times New Roman', serif");
    expect(emailFontStack('Roboto Mono')).toBe("'Roboto Mono', 'Courier New', monospace");
    expect(emailFontStack('Not A Font')).toBe('');
  });

  it('offers web-safe and bundled faces for signatures, each with a mail-safe stack', () => {
    const families = SIGNATURE_FONTS.map(font => font.family);
    expect(families).toEqual(expect.arrayContaining(['Arial', 'Georgia', 'Courier New', 'Inter']));
    expect(signatureFontStack('Georgia')).toBe("Georgia, 'Times New Roman', serif");
    expect(signatureFontStack('Inter')).toBe("Inter, Arial, Helvetica, sans-serif");
    expect(signatureFontStack('Fira Code')).toBe("'Fira Code', 'Courier New', monospace");
    expect(signatureFontStack('Lobster')).toBe("Lobster, Arial, Helvetica, sans-serif");
    expect(signatureFontStack('Comic Sans MS')).toBe('');
  });
});
