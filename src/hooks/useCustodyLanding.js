import { useEffect, useRef, useState } from 'react';

/** Matches --mv-handoff in src/styles/index.css. */
const HOLD_MS = 620;

/**
 * "This message just changed hands" — for one handoff, then nothing.
 *
 * Custody is the product's whole claim, and a colour that swaps between two
 * frames cannot say that anything happened: a row that turns emerald mid-sync
 * looks identical to a row that was always emerald. This returns the new tone
 * for `HOLD_MS` so the row can play the handoff, and null the rest of the time.
 *
 * The pair, not the tone, is the guard. A virtualized list recycles component
 * instances: scroll far enough and this same instance is rendering a different
 * message, whose tone differs from the last one it drew. That is not a
 * handoff — it is the same mistake as keying a message by its uid alone. Only
 * the same scope key changing tone counts, and a key change clears any beat
 * still in flight so a landing never paints onto the message that replaced it.
 *
 * @param {string|null} scopeKey account-mailbox-uid; a bare uid is not a key
 * @param {string|null} tone     'server' | 'local' | 'only-copy'
 * @returns {string|null} the tone that just landed, or null
 */
export function useCustodyLanding(scopeKey, tone) {
  const previous = useRef(null);
  const timer = useRef(null);
  const [landed, setLanded] = useState(null);

  useEffect(() => {
    const before = previous.current;
    previous.current = { scopeKey, tone };

    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }

    const handedOver =
      before !== null &&
      scopeKey !== null &&
      before.scopeKey === scopeKey &&
      before.tone !== tone;

    if (!handedOver) {
      // Functional form so React bails out instead of re-rendering every
      // recycled row on every scroll tick.
      setLanded((current) => (current === null ? current : null));
      return;
    }

    setLanded(tone);
    timer.current = setTimeout(() => {
      timer.current = null;
      setLanded(null);
    }, HOLD_MS);
  }, [scopeKey, tone]);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  return landed;
}
