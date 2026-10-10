import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getChatLinkColors } from '../mailChrome';
import { contrast, tokens } from './colorMath';

const css = readFileSync(new URL('../../styles/index.css', import.meta.url), 'utf8');
const chat = (mode, palette) => tokens(css, `[data-theme="${mode}"][data-palette="${palette}"] {`, 'chat');

describe('chat bubbles on the teal palette', () => {
  for (const mode of ['dark', 'light']) {
    it(`${mode}: sent text and links, and received links, stay readable on their own bubbles`, () => {
      const bubbles = chat(mode, 'teal');
      const links = getChatLinkColors('teal', mode);
      expect(contrast('#ffffff', bubbles['sent-bg']), 'white on sent bubble').toBeGreaterThanOrEqual(4.5);
      expect(contrast(links.sent, bubbles['sent-bg']), 'sent link').toBeGreaterThanOrEqual(4.5);
      expect(contrast(links.received, bubbles['received-bg']), 'received link').toBeGreaterThanOrEqual(4.5);
      expect(contrast(bubbles['received-text'], bubbles['received-bg']), 'received text').toBeGreaterThanOrEqual(4.5);
    });
  }
});
