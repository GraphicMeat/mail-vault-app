import React, { forwardRef } from 'react';
import { Loader } from 'lucide-react';

/**
 * The app's button.
 *
 * Before this component the client had 399 `<button>` elements wearing 281
 * distinct class strings — five spellings of the same ghost icon button, two
 * weights of the same primary, three paddings of the same secondary. The
 * variants below are those families, deduplicated against DESIGN.md rather
 * than against whichever sibling happened to be copied.
 *
 * Focus is deliberately absent: `src/styles/index.css` already gives every
 * `button:focus-visible` a 2px accent outline at 2px offset. Adding a ring
 * here would double it.
 */

const VARIANTS = {
  /** The one live action in a view. Indigo fill, white label. */
  primary: 'bg-mail-accent-fill text-white hover:bg-mail-accent-hover font-semibold',
  /** The Cancel side of every dialog. Outnumbers primary two to one. */
  secondary: 'bg-mail-surface border border-mail-border text-mail-text hover:bg-mail-surface-hover font-medium',
  /** Confirms a destruction that the surrounding copy has already named. */
  danger: 'bg-mail-danger-fill text-white hover:bg-mail-danger font-medium',
  /** A raised neutral action inside a panel that is already `surface`. */
  subtle: 'bg-mail-surface-hover text-mail-text hover:bg-mail-border font-medium',
  /** Accent as a tint, for a secondary action that is still the accented one. */
  accentTint: 'bg-mail-accent/10 text-mail-accent-text hover:bg-mail-accent/20 font-medium',
  /** Destructive, but not the confirming step — "Remove", "Disconnect". */
  dangerTint: 'bg-mail-danger/10 text-mail-danger hover:bg-mail-danger/20 font-medium',
  /** Row and toolbar actions: no fill at rest, glyph lifts to `text` on hover. */
  ghost: 'text-mail-text-muted hover:text-mail-text hover:bg-mail-surface-hover',
  /** Inline text action. No padding, no fill — it reads as a link. */
  link: 'text-mail-accent-text hover:text-mail-accent-hover',
};

const SIZES = {
  xs: 'px-2 py-1 text-xs gap-1',
  sm: 'px-3 py-1.5 text-sm gap-1.5',
  md: 'px-4 py-2 text-sm gap-2',
  lg: 'px-4 py-2.5 text-sm gap-2',
};

/** Square hit-areas for icon-only buttons. Glyph size stays the caller's. */
const ICON_SIZES = { xs: 'p-1', sm: 'p-1.5', md: 'p-2', lg: 'p-2.5' };

const SPINNER = { xs: 12, sm: 12, md: 14, lg: 14 };

export const Button = forwardRef(function Button(
  {
    variant = 'secondary',
    size = 'md',
    icon = false,
    pill = false,
    loading = false,
    fullWidth = false,
    className = '',
    children,
    disabled,
    type = 'button',
    ...rest
  },
  ref
) {
  if (import.meta.env.DEV && icon && !rest['aria-label'] && !rest.title) {
    console.warn('[ui/Button] icon-only button with no aria-label or title', children);
  }

  // A caller that passes its own `justify-*` means it: Tailwind emits
  // `justify-center` after `justify-start`, so leaving both on would silently
  // re-center a left-aligned row button.
  const justify = /(^|\s)justify-/.test(className) ? '' : 'justify-center';
  const shape = pill ? 'rounded-full' : 'rounded-lg';
  const geometry = icon ? ICON_SIZES[size] : SIZES[size];
  const layout = icon
    ? `inline-flex items-center ${justify}`
    : `inline-flex items-center ${justify} ${fullWidth ? 'w-full' : ''}`;

  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={`${layout} ${geometry} ${shape} ${VARIANTS[variant]} transition-colors disabled:opacity-50 ${className}`}
      {...rest}
    >
      {loading && <Loader size={SPINNER[size]} className="animate-spin" aria-hidden="true" />}
      {children}
    </button>
  );
});
