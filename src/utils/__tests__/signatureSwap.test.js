// Changing From swaps the signature in the body the person is writing, and
// nothing else in it.
import { describe, it, expect } from 'vitest';
import { swapSignature } from '../signatureCaret';

const ONE = '<p></p><p>--</p><p>Sig One</p>';
const TWO = '<p></p><p>--</p><p>Sig Two</p>';

describe('swapSignature', () => {
  it('replaces the old block with the new one and keeps what was typed', () => {
    expect(swapSignature('<p>Hello</p>' + ONE, ONE, TWO)).toBe('<p>Hello</p>' + TWO);
  });

  it('finds the block after the editor padded its blank line', () => {
    expect(swapSignature('<p>Hello</p><p><br></p><p>--</p><p>Sig One</p>', ONE, TWO))
      .toBe('<p>Hello</p>' + TWO);
  });

  it('removes the old block when the new account has none', () => {
    expect(swapSignature('<p>Hello</p>' + ONE, ONE, '')).toBe('<p>Hello</p>');
  });

  it('appends the new block when there was none', () => {
    expect(swapSignature('<p>Hello</p>', '', TWO)).toBe('<p>Hello</p>' + TWO);
    expect(swapSignature('', '', TWO)).toBe(TWO);
  });

  it('puts it above a forwarded original, where a forward opens with it', () => {
    const quoted = '<p>---------- Forwarded message ----------</p><p>Original</p>';
    expect(swapSignature(quoted, '', TWO, { above: true })).toBe(TWO + quoted);
    expect(swapSignature(ONE + quoted, ONE, TWO, { above: true })).toBe(TWO + quoted);
  });

  it('leaves the body alone when neither account signs', () => {
    expect(swapSignature('<p>Hello</p>', '', '')).toBe('<p>Hello</p>');
  });
});
