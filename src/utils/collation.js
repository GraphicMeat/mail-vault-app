import { getLocale } from '../i18n/index.js';

/**
 * Comparator for anything a person reads in a sorted list.
 *
 * A bare `.sort()` compares UTF-16 code points, which puts `Über` after `Zebra`
 * in German and scrambles kana in Japanese. `numeric` keeps `Folder 10` after
 * `Folder 9`; `sensitivity: 'base'` stops a lowercase name being exiled.
 *
 * Never use this to sort ids, UIDs, dates, or anything feeding a cache key —
 * the order would then vary by the reader's language.
 */
export const compareNames = (a, b) =>
  String(a ?? '').localeCompare(String(b ?? ''), getLocale(), {
    numeric: true,
    sensitivity: 'base',
  });
