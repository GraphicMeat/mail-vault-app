/**
 * The closed look of a field that opens a picker (Combobox, DateTimePicker).
 * One fixed height rather than two paddings, so two pickers sitting in a row
 * line up whatever text or glyph each one shows.
 */
export const FIELD_TRIGGER = 'h-8 px-2 flex items-center gap-1.5 text-sm text-left text-mail-text bg-transparent '
  + 'border border-mail-border rounded-md outline-none hover:border-mail-border-strong transition-colors';

/**
 * Where a picker's portaled panel of about `height` px goes: under `el`, or
 * over it when the window has more room above (Compose's schedule panel sits
 * at the bottom of the window). The Popover still nudges it inside the edges.
 */
export function anchorTo(el, height) {
  const r = el.getBoundingClientRect();
  const below = window.innerHeight - r.bottom;
  return below >= height + 8 || below >= r.top
    ? { top: r.bottom + 4, left: r.left }
    : { bottom: window.innerHeight - r.top + 4, left: r.left };
}
