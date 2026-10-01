// @vitest-environment jsdom
// Received mail in a Google Font: the families it chose, and the stylesheet
// links that would have the webview fetch them from Google itself.
import { describe, expect, it } from 'vitest';
import { stripGoogleFontImports, mailFontFamilies, fontSourcesOf, MAX_MAIL_FONTS } from '../mailFonts';

describe('stripGoogleFontImports', () => {
  it('drops a Google Fonts stylesheet link, whatever its quoting', () => {
    const css2 = '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Lora:wght@400;700&display=swap">';
    expect(stripGoogleFontImports(`<p>a</p>${css2}<p>b</p>`)).toBe('<p>a</p><p>b</p>');
    expect(stripGoogleFontImports("<link href='https://fonts.googleapis.com/css?family=Lato' rel='stylesheet' />x")).toBe('x');
    expect(stripGoogleFontImports('<LINK rel=stylesheet href=https://fonts.googleapis.com/css?family=Lato>x')).toBe('x');
    expect(stripGoogleFontImports('<link href="//fonts.googleapis.com/css?family=Lato" rel="stylesheet">x')).toBe('x');
    // The font files and a preconnect to them leave the machine too.
    expect(stripGoogleFontImports('<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>x')).toBe('x');
  });

  it('drops an @import of Google Fonts in every form, css and css2', () => {
    const style = rule => `<style>${rule}\np { color: red; }</style>`;
    const kept = '<style>\np { color: red; }</style>';
    expect(stripGoogleFontImports(style("@import url('https://fonts.googleapis.com/css?family=Open+Sans');"))).toBe(kept);
    expect(stripGoogleFontImports(style('@import url("https://fonts.googleapis.com/css2?family=Lora:wght@400;700&display=swap");'))).toBe(kept);
    expect(stripGoogleFontImports(style('@import url(https://fonts.googleapis.com/css2?family=Lora:wght@400;700);'))).toBe(kept);
    expect(stripGoogleFontImports(style('@import "https://fonts.googleapis.com/css2?family=Lora:wght@400;700";'))).toBe(kept);
    expect(stripGoogleFontImports(style("@IMPORT 'https://fonts.googleapis.com/css?family=Lato' screen;"))).toBe(kept);
  });

  it('leaves every other link and import alone', () => {
    const html = '<link rel="stylesheet" href="https://example.test/mail.css">'
      + '<style>@import url("https://cdn.example.test/fonts.css");</style>'
      + '<a href="https://fonts.googleapis.com/css?family=Lato">a link in the text</a>';
    expect(stripGoogleFontImports(html)).toBe(html);
    expect(stripGoogleFontImports('')).toBe('');
    expect(stripGoogleFontImports(null)).toBe(null);
  });

  it('is idempotent', () => {
    const html = '<link rel=stylesheet href="https://fonts.googleapis.com/css?family=Lato"><style>@import url(https://fonts.googleapis.com/css?family=Lora);b{}</style><p>x</p>';
    const once = stripGoogleFontImports(html);
    expect(once).toBe('<style>b{}</style><p>x</p>');
    expect(stripGoogleFontImports(once)).toBe(once);
  });
});

describe('mailFontFamilies', () => {
  it('takes the first family of each font-family list, quoted or not', () => {
    expect(mailFontFamilies(['font-family: Lora, Georgia, serif'])).toEqual(['Lora']);
    expect(mailFontFamilies(["p { font-family: 'Open Sans', Arial }"])).toEqual(['Open Sans']);
    expect(mailFontFamilies(['font-family:"Playfair Display";color:red'])).toEqual(['Playfair Display']);
    expect(mailFontFamilies(['font-family: Lato !important'])).toEqual(['Lato']);
  });

  it('matches the catalogue case-insensitively and answers its spelling', () => {
    expect(mailFontFamilies(['font-family: lora'])).toEqual(['Lora']);
    expect(mailFontFamilies(['font-family: OPEN  SANS, sans-serif'])).toEqual(['Open Sans']);
  });

  it('reads the family out of a font shorthand', () => {
    expect(mailFontFamilies(["font: italic 600 14px/1.4 'Lora', serif"])).toEqual(['Lora']);
    expect(mailFontFamilies(['div{font:bold 1.2em Merriweather,Georgia}'])).toEqual(['Merriweather']);
    expect(mailFontFamilies(['font: small-caps 700 large Montserrat'])).toEqual(['Montserrat']);
    // A unitless weight is not the size.
    expect(mailFontFamilies(['font: 600 Lato'])).toEqual([]);
    // System fonts and keywords name no family.
    expect(mailFontFamilies(['font: caption', 'font: -apple-system-body', 'font: inherit'])).toEqual([]);
    // A longhand is not the shorthand.
    expect(mailFontFamilies(['font-size: 12px Lora; font-weight: 700'])).toEqual([]);
  });

  it('never takes a later family of a stack: the system stack with Roboto in it is no request for Roboto', () => {
    const system = "body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; }";
    expect(mailFontFamilies([system])).toEqual([]);
    expect(mailFontFamilies(['font-family: Arial, Lora'])).toEqual([]);
  });

  it('reads a <font face> by its first name', () => {
    expect(mailFontFamilies([], ['Lato, Arial'])).toEqual(['Lato']);
    expect(mailFontFamilies([], ["'Pacifico'"])).toEqual(['Pacifico']);
  });

  it('ignores families outside the catalogue and generics, and dedupes', () => {
    expect(mailFontFamilies(['font-family: Comic Sans MS', 'font-family: serif', 'font-family: var(--brand)'])).toEqual([]);
    expect(mailFontFamilies(['font-family: Lora', 'font-family: lora, serif', 'font: 12px Lora'], ['Lora'])).toEqual(['Lora']);
  });

  it(`stops at ${MAX_MAIL_FONTS} families a message`, () => {
    const css = ['Lora', 'Lato', 'Roboto', 'Pacifico', 'Merriweather', 'Montserrat'].map(f => `font-family: ${f}`);
    expect(MAX_MAIL_FONTS).toBe(4);
    expect(mailFontFamilies(css)).toEqual(['Lora', 'Lato', 'Roboto', 'Pacifico']);
  });
});

describe('fontSourcesOf', () => {
  it('reads style sheets, style attributes and font faces of a rendered document', () => {
    const doc = document.implementation.createHTMLDocument('');
    doc.head.innerHTML = '<style>h1 { font-family: Lora }</style>';
    doc.body.innerHTML = '<p style="font: 14px Lato">a</p><font face="Pacifico, cursive">b</font><span>c</span>';
    const [css, faces] = fontSourcesOf(doc);
    expect(mailFontFamilies(css, faces)).toEqual(['Lora', 'Lato', 'Pacifico']);
  });
});
