// ── "You mentioned an attachment" check at send ──
//
// The words for it in every UI language, checked whatever the UI is set to:
// people write mail in more languages than the one their app speaks. Whole
// words only ("detached", "Anhänger" never count), so `\b` will not do: it
// is ASCII-only in JS and breaks at "ä". CJK has no word breaks; a plain
// substring is the word there.

const WORDS = [
  // en
  'attach', 'attached', 'attaching', 'attachment', 'attachments', 'enclosed', 'enclosing',
  // de
  'anhang', 'anhänge', 'anhängen', 'angehängt', 'anbei', 'beigefügt',
  // es
  'adjunto', 'adjunta', 'adjuntos', 'adjuntas', 'adjuntado', 'adjunté',
  // fr
  'pièce jointe', 'pièces jointes', 'ci-joint', 'ci-jointe', 'ci-joints', 'ci-jointes',
  // it
  'allegato', 'allegata', 'allegati', 'allegate',
  // pt-BR
  'anexo', 'anexa', 'anexos', 'anexas', 'anexado', 'anexada', 'anexei',
];
const CJK = ['添付', '첨부', '附件', '附上', '随附'];

const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const MENTION = new RegExp(
  `(?<![\\p{L}\\p{N}-])(?:${WORDS.map(escape).join('|')})(?![\\p{L}\\p{N}-])|${CJK.join('|')}`,
  'iu',
);

// What the sender wrote: no quoted ("> ") lines, nothing under the "--"
// signature separator compose puts above a signature.
function ownText(text) {
  const lines = [];
  for (const line of (text || '').split('\n')) {
    if (/^--\s?$/.test(line)) break;
    if (!/^\s*>/.test(line)) lines.push(line);
  }
  return lines.join('\n');
}

export const mentionsAttachment = text => MENTION.test(ownText(text));

/// True when the message talks about an attachment and carries none. A
/// reply's or forward's subject is the original's, so only a new message's
/// subject is read.
export function missingAttachment({ mode, subject, bodyText, attachmentCount }) {
  if (attachmentCount > 0) return false;
  return mentionsAttachment(bodyText) || (mode === 'new' && mentionsAttachment(subject));
}
