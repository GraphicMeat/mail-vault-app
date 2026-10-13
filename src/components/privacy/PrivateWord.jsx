import React from 'react';
import { usePrivateAttr } from '../../hooks/usePrivacy';

/**
 * A lone word as privacy mode shows it: `{ text, masked }`, `text` being the
 * filler when masked. Words handed over lowercased (an email's keywords) never
 * look like names to the detector, which only takes a capitalised word for one
 * (lowercase "mark" is a verb), so a surname picked out of a message would show
 * as plain text. The word is read as it would be written capitalised: one that
 * could be someone's name is masked.
 */
export function usePrivateWord(word) {
  const mask = usePrivateAttr();
  const text = String(word ?? '');
  const titled = text.charAt(0).toUpperCase() + text.slice(1);
  const out = mask(titled, 'text');
  if (!out || out === titled) return { text, masked: false };
  return { text: out.toLowerCase(), masked: true };
}

/** `usePrivateWord`, rendered the way `Private` renders a masked run. */
export function PrivateWord({ word }) {
  const { text, masked } = usePrivateWord(word);
  return masked ? <span className="mv-private" aria-hidden="true">{text}</span> : text;
}
