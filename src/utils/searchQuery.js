/// Lift the filter terms out of a search box that is otherwise free text.
///
/// Only `tag:` is understood; anything else stays in the text, so a message
/// that genuinely contains "from:bob" is still findable and no typo produces
/// an error dialog.
const TAG_TERM = /(^|\s)tag:("([^"]+)"|\S+)/gi;
// `field:Name=value`, `field:"Two words"=value`, `field:Name="two words"`, or
// `field:Name` on its own for "has any value at all".
const FIELD_TERM = /(^|\s)field:("([^"]+)"|[^\s="]+)(?:=("([^"]+)"|\S+))?/gi;

export function parseSearchQuery(query) {
  const input = typeof query === 'string' ? query : '';
  const tags = [];
  const fields = [];
  let text = input.replace(TAG_TERM, (match, lead, raw, quoted) => {
    const name = (quoted ?? raw).trim();
    if (!name) return match;
    tags.push(name);
    return lead;
  });
  text = text.replace(FIELD_TERM, (match, lead, rawName, quotedName, rawValue, quotedValue) => {
    const name = (quotedName ?? rawName ?? '').trim();
    if (!name) return match;
    const value = rawValue === undefined ? null : (quotedValue ?? rawValue).trim();
    fields.push({ name, value });
    return lead;
  });
  return { text: text.trim().replace(/\s{2,}/g, ' '), tags, fields };
}
