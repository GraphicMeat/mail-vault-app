/**
 * What each mask of a social capture hides, by the index its element carries
 * (`data-mv-i`): the hit map's way back from a masked word to the word. Held
 * here, never in the markup. One table per capture (captureAppWindow resets it);
 * the same original always gets the same index.
 */
let originals = [];
const indexOf = new Map();

export function resetCaptureMasks() {
  originals = [];
  indexOf.clear();
}

export function captureMaskIndex(original) {
  const key = String(original);
  if (!indexOf.has(key)) indexOf.set(key, originals.push(key) - 1);
  return indexOf.get(key);
}

export const captureMaskOriginal = (index) => originals[index];
