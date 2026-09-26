/// Lift the filter terms out of a search box that is otherwise free text.
///
/// `tag:`, `field:` and the Gmail operators (`from:`, `to:`, `in:`,
/// `has:attachment`, `is:unread`, `before:`, `after:`, `-term`) are
/// understood. Anything else, and any operator whose value makes no sense
/// (`is:starred`, `before:2026-13-45`), stays in the text, so no typo produces
/// an error dialog.
const TAG_TERM = /(^|\s)tag:("([^"]+)"|\S+)/gi;
// `field:Name=value`, `field:"Two words"=value`, `field:Name="two words"`, or
// `field:Name` on its own for "has any value at all".
const FIELD_TERM = /(^|\s)field:("([^"]+)"|[^\s="]+)(?:=("([^"]+)"|\S+))?/gi;
const OPERATOR_TERM = /(^|\s)(from|to|in|has|is|before|after):("([^"]+)"|\S+)/gi;
// A leading `-` only: `e-mail` and a lone `-` are text.
const EXCLUDE_TERM = /(^|\s)-("([^"]+)"|[^\s"]+)/g;

/// `in:` words that name a folder by its role. The canonical ids resolve per
/// account through the special-use flags (`_resolveMailboxPath`); `all` is the
/// every-folder scope the filter UI already has.
const IN_FOLDERS = {
  inbox: 'INBOX', sent: 'Sent', drafts: 'Drafts', trash: 'Trash', spam: 'Junk', junk: 'Junk',
  archive: 'Archive', anywhere: 'all',
};

/// `YYYY-MM-DD` or `YYYY/MM/DD`, shifted by `days`, as the filter UI's
/// `YYYY-MM-DD`. Calendar arithmetic in UTC, so no local offset moves the day.
function day(value, days = 0) {
  const match = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(value);
  if (!match) return null;
  const [year, month, date] = match.slice(1).map(Number);
  const stamp = new Date(Date.UTC(year, month - 1, date));
  if (stamp.getUTCMonth() !== month - 1 || stamp.getUTCDate() !== date) return null;
  stamp.setUTCDate(stamp.getUTCDate() + days);
  return stamp.toISOString().slice(0, 10);
}

export function parseSearchQuery(query) {
  const input = typeof query === 'string' ? query : '';
  const tags = [];
  const fields = [];
  const operators = {
    sender: null, to: null, folder: null, hasAttachments: false, unread: false, dateFrom: null, dateTo: null,
  };
  const exclude = [];
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
  text = text.replace(OPERATOR_TERM, (match, lead, key, raw, quoted) => {
    const value = (quoted ?? raw).trim();
    if (!value) return match;
    const word = value.toLowerCase();
    switch (key.toLowerCase()) {
      case 'from': operators.sender = value; break;
      case 'to': operators.to = value; break;
      case 'in': operators.folder = IN_FOLDERS[word] || value; break;
      case 'has':
        if (word !== 'attachment' && word !== 'attachments') return match;
        operators.hasAttachments = true;
        break;
      case 'is':
        if (word !== 'unread') return match;
        operators.unread = true;
        break;
      // Gmail: `after:` is the first day in, `before:` the first day out. The
      // filter's end date is inclusive, so `before:` keeps the day before.
      case 'after': {
        const from = day(value);
        if (!from) return match;
        operators.dateFrom = from;
        break;
      }
      case 'before': {
        const to = day(value, -1);
        if (!to) return match;
        operators.dateTo = to;
        break;
      }
      default: return match;
    }
    return lead;
  });
  text = text.replace(EXCLUDE_TERM, (match, lead, raw, quoted) => {
    const term = (quoted ?? raw).trim();
    if (!term) return match;
    exclude.push(term);
    return lead;
  });
  return { text: text.trim().replace(/\s{2,}/g, ' '), tags, fields, ...operators, exclude };
}
