/// Lift the filter terms out of a search box that is otherwise free text.
///
/// Only `tag:` is understood; anything else stays in the text, so a message
/// that genuinely contains "from:bob" is still findable and no typo produces
/// an error dialog.
const TAG_TERM = /(^|\s)tag:("([^"]+)"|\S+)/gi;

export function parseSearchQuery(query) {
  const input = typeof query === 'string' ? query : '';
  const tags = [];
  const text = input.replace(TAG_TERM, (match, lead, raw, quoted) => {
    const name = (quoted ?? raw).trim();
    if (!name) return match;
    tags.push(name);
    return lead;
  });
  return { text: text.trim().replace(/\s{2,}/g, ' '), tags };
}
