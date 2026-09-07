/**
 * The ground a list row paints: at most one of hover, unread surface, the
 * accent tint and the two marking greys. They are equal-specificity utilities,
 * so a row asks for exactly one — whichever the stylesheet declared last would
 * otherwise win, and hovering the row you are in would hide its own mark
 * (69313e84).
 *
 * @param {object} o
 * @param {'hover'|'selection'} o.highlight  the emailRowHighlight setting
 * @param {boolean} o.selected   this row holds the open message
 * @param {boolean} o.related    this row belongs to the open message's thread
 * @param {boolean} o.unread
 * @param {string}  [o.markedPad]  padding that compensates the 2px accent border
 * @param {string}  [o.restPad]    padding when no border is drawn
 * @returns {string} class names
 */
export function listRowGround({
  highlight,
  selected,
  related,
  unread,
  markedPad = 'pl-[14px]',
  restPad = '',
}) {
  const join = (...parts) => parts.filter(Boolean).join(' ');
  const marking = highlight === 'selection';

  // The open row. In hover mode it is the accent tint plus the left border,
  // which eats 2px of the padding box — hence the second padding value.
  if (selected) {
    return marking
      ? join('bg-mail-row-selected', restPad)
      : join('bg-mail-accent-tint border-l-2 border-l-mail-accent', markedPad);
  }
  // The rest of the open message's thread. Hover mode has no sibling ground.
  if (related && marking) return join('bg-mail-row-related', restPad);

  return join(
    unread && 'bg-mail-surface',
    !marking && 'hover:bg-mail-surface-hover',
    restPad,
  );
}
