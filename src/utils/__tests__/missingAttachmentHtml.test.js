// @vitest-environment jsdom
//
// The compose body reaches missingAttachment through the real htmlToText:
// the signature cutoff depends on "--" landing on a line of its own.
import { it, expect } from 'vitest';
import { htmlToText } from '../../components/RichTextEditor';
import { mentionsAttachment } from '../missingAttachment';

it('reads a mention in the editor HTML', () => {
  expect(mentionsAttachment(htmlToText('<p>Hi,</p><p>see attached.</p>'))).toBe(true);
});

it('stops at the signature compose writes', () => {
  expect(mentionsAttachment(htmlToText('<p>Sounds good.</p><p></p><p>--</p><p>Jo, see attached policy</p>'))).toBe(false);
});

it('skips a pasted quote', () => {
  expect(mentionsAttachment(htmlToText('<p>Sounds good.</p><blockquote><p>I attached it</p></blockquote>'))).toBe(false);
});
