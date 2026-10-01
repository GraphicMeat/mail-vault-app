/**
 * Split a "Meta+P" style binding into its parts for display. The hook's
 * encoder names Shift only for named keys, so a capital letter after a
 * modifier means Shift was held: show it, or Cmd+Shift+P reads as Cmd+P.
 */
export function shortcutParts(binding) {
  const parts = binding.split('+');
  const last = parts[parts.length - 1];
  if (parts.length > 1 && /^\p{Lu}$/u.test(last)) parts.splice(parts.length - 1, 0, 'Shift');
  return parts;
}
