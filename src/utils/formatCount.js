import { getLocale } from '../i18n/index.js';

/**
 * Thousands-group a count for display, using the APP's chosen locale.
 *
 * A bare `n.toLocaleString()` uses the runtime's default locale, not the
 * app's — so a Lithuanian OS renders "1 200" (space-grouped) for a user whose
 * MailVault UI language is English, same class of bug as a bare
 * `localeCompare` (see collation.js).
 */
export const formatCount = (n) => Number(n).toLocaleString(getLocale());
