// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import * as helpers from '../editorHtml';
import * as component from '../../components/RichTextEditor';

describe('editorHtml', () => {
  it('is the same code RichTextEditor re-exports, so old importers and mocks of the component still resolve it', () => {
    for (const name of ['htmlToText', 'inlineComposeSpacing', 'padEmptyLines', 'editorExtensions', 'isPaddingBreak']) {
      expect(typeof helpers[name]).toBe('function');
      expect(component[name]).toBe(helpers[name]);
    }
  });

  it('reads HTML as text line for line', () => {
    expect(helpers.htmlToText('<p>One</p><p></p><p>Two</p>')).toBe('One\n\nTwo');
    expect(helpers.htmlToText('')).toBe('');
  });

  it('carries the editor paragraph spacing out with the message and keeps an authored margin', () => {
    expect(helpers.inlineComposeSpacing('<p>a</p>')).toContain('margin: 0px 0px 0.25em');
    expect(helpers.inlineComposeSpacing('<p style="margin: 3px">a</p>')).toContain('margin: 3px');
  });

  it('pads an empty paragraph with a break', () => {
    expect(helpers.padEmptyLines('<p></p>')).toBe('<p><br></p>');
  });
});
