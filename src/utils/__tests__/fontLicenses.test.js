import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { APP_FONTS } from '../appFont';

// The OFL lets these fonts ship with the app only if the license text ships
// with them. Driven from fonts.css itself, so a face added there without its
// license (or a choice added without its face) fails here, not in a review.
const ROOT = process.cwd();
const css = readFileSync(resolve(ROOT, 'src/styles/fonts.css'), 'utf8');
const faces = [...css.matchAll(/@font-face\s*{([^}]*)}/g)].map(([, body]) => ({
  family: body.match(/font-family:\s*'([^']+)'/)[1],
  url: body.match(/url\('([^']+)'\)/)[1],
}));
const families = [...new Set(faces.map(face => face.family))];
const licensePath = family => resolve(ROOT, 'public/licenses/fonts', `${family.toLowerCase().replace(/ /g, '-')}.txt`);

describe('bundled fonts', () => {
  it('every face points at a file that exists', () => {
    expect(faces.length).toBeGreaterThan(0);
    expect(faces.filter(face => !existsSync(resolve(ROOT, 'src/styles', face.url))).map(face => face.url)).toEqual([]);
  });

  it('every family ships its SIL Open Font License text', () => {
    const missing = families.filter(family => !existsSync(licensePath(family))
      || !readFileSync(licensePath(family), 'utf8').includes('SIL OPEN FONT LICENSE'));
    expect(missing).toEqual([]);
  });

  it('every font choice but the system font is bundled', () => {
    const unbundled = APP_FONTS.filter(font => font.family && !families.includes(font.family)).map(font => font.id);
    expect(unbundled).toEqual([]);
    expect(APP_FONTS.filter(font => font.mono).map(font => font.id)).toEqual(['jetbrains-mono', 'fira-code', 'ibm-plex-mono']);
  });

  // The variable Instrument Sans breaks word spacing under WebKitGTK at the
  // app's body size (fonts.css says why); its static weights do not.
  it('Instrument Sans is bundled as static weights, not the variable font', () => {
    const weights = [...css.matchAll(/@font-face\s*{([^}]*)}/g)]
      .map(([, body]) => body)
      .filter(body => body.includes("'Instrument Sans'"))
      .map(body => body.match(/font-weight:\s*([^;]+);/)[1].trim());
    expect(weights.sort()).toEqual(['400', '400', '500', '500', '600', '600', '700', '700']);
  });
});
