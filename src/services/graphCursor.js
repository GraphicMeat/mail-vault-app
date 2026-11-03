// Where the next page of a Graph folder starts.
//
// Graph lists newest first. A position counted in rows moves whenever mail is
// deleted or arrives anywhere in the folder, so a bare `$skip` loses the row
// that slid into the range already skipped. A position is a moment
// (receivedDateTime) plus how many rows at exactly that moment were listed
// already: the next page asks for "received at or before the moment", past
// those rows. Mail deleted or arriving elsewhere cannot move a moment.
//
// A cursor is `{ key: 'account:mailbox', before, skip }`. `before` is null for
// rows with no date, which can only be counted.

/** The cursor after `headers` (newest first) were read at `prior`. */
export function graphCursorAfter(key, headers, prior) {
  const base = prior?.key === key ? prior : null;
  if (!headers.length) return base ?? { key, before: null, skip: 0 };
  const last = headers[headers.length - 1].date;
  if (!last) return { key, before: base?.before ?? null, skip: (base?.skip ?? 0) + headers.length };
  const ties = headers.filter(h => h.date === last).length;
  return { key, before: last, skip: (base?.before === last ? base.skip : 0) + ties };
}

/**
 * The cursor for a first-page listing. One that already reaches further back
 * than the page stays: the list keeps the older rows it covers.
 */
export function pickGraphCursor(prior, key, headers) {
  const page = graphCursorAfter(key, headers, null);
  return prior?.key === key && prior.before && page.before && prior.before < page.before ? prior : page;
}

/** The listing arguments that read the page at `cursor` (the top, for none). */
export function graphPageArgs(cursor, key, top) {
  if (cursor?.key !== key) return { top, skip: 0 };
  return cursor.before ? { top, skip: cursor.skip, before: cursor.before } : { top, skip: cursor.skip };
}

export const sameGraphCursor = (a, b) => a?.key === b?.key && a?.before === b?.before && a?.skip === b?.skip;
