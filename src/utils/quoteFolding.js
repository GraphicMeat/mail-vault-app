/**
 * Splits plain text email body into { newContent, quotedContent }.
 * Returns the original text as newContent if no quotes are detected.
 */

const QUOTE_START_PATTERNS = [
  /^On .+wrote:\s*$/im,
  /^-{4,}\s*Original Message\s*-{4,}/im,
  /^From:\s*.+\nSent:\s*.+\nTo:\s*.+/im,
  /^_{4,}/m,
];

export function splitQuotedContent(text) {
  if (!text) return { newContent: '', quotedContent: '' };

  // 1. Check delimiter-based patterns first
  let splitIndex = text.length;
  for (const pattern of QUOTE_START_PATTERNS) {
    const match = text.match(pattern);
    if (match && match.index < splitIndex) {
      splitIndex = match.index;
    }
  }

  if (splitIndex < text.length) {
    return {
      newContent: text.substring(0, splitIndex).trimEnd(),
      quotedContent: text.substring(splitIndex),
    };
  }

  // 2. Check for > prefix quote blocks at the end
  const lines = text.split('\n');
  let quoteStartLine = -1;

  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('>') || trimmed === '') {
      quoteStartLine = i;
    } else {
      break;
    }
  }

  if (quoteStartLine >= 0 && lines.slice(quoteStartLine).some(l => l.trim().startsWith('>'))) {
    return {
      newContent: lines.slice(0, quoteStartLine).join('\n').trimEnd(),
      quotedContent: lines.slice(quoteStartLine).join('\n'),
    };
  }

  return { newContent: text, quotedContent: '' };
}
