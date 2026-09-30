import { EMOJI } from './emojiData';

/// The commands the "/" menu offers in the message editor. Adding one is one
/// entry: `run(editor, range)` gets the editor and the range of the typed
/// "/query", and does the work (deleting that range is its own job, so a
/// command that keeps the menu open, like Emoji, can rewrite it instead).
/// `keywords` are English, searched whatever the app language is.
export const SLASH_COMMANDS = [
  {
    id: 'emoji', labelKey: 'editor.slash.emoji', hintKey: 'editor.slash.emojiHint',
    keywords: ['emoji', 'emoticon', 'smiley'],
    // Same menu, emoji list: the text becomes "/emoji " and the menu reads it.
    run: (editor, range) => editor.chain().focus().insertContentAt(range, '/emoji ').run(),
  },
  {
    id: 'bulletList', labelKey: 'editor.slash.bulletList', hintKey: 'editor.slash.bulletListHint',
    keywords: ['bullet', 'list', 'unordered', 'ul'],
    run: (editor, range) => editor.chain().focus().deleteRange(range).toggleBulletList().run(),
  },
  {
    id: 'numberedList', labelKey: 'editor.slash.numberedList', hintKey: 'editor.slash.numberedListHint',
    keywords: ['numbered', 'ordered', 'list', 'ol'],
    run: (editor, range) => editor.chain().focus().deleteRange(range).toggleOrderedList().run(),
  },
  {
    id: 'quote', labelKey: 'editor.slash.quote', hintKey: 'editor.slash.quoteHint',
    keywords: ['quote', 'blockquote', 'citation'],
    run: (editor, range) => editor.chain().focus().deleteRange(range).toggleBlockquote().run(),
  },
  {
    id: 'codeBlock', labelKey: 'editor.slash.codeBlock', hintKey: 'editor.slash.codeBlockHint',
    keywords: ['code', 'snippet', 'pre', 'monospace'],
    run: (editor, range) => editor.chain().focus().deleteRange(range).toggleCodeBlock().run(),
  },
  {
    id: 'divider', labelKey: 'editor.slash.divider', hintKey: 'editor.slash.dividerHint',
    keywords: ['divider', 'line', 'rule', 'hr', 'separator'],
    run: (editor, range) => editor.chain().focus().deleteRange(range).setHorizontalRule().run(),
  },
];

const EMOJI_MODE = 'emoji ';
const EMOJI_LISTED = 30;      // the bare list; a search shows everything it finds, up to the same cap
const MIN_EMOJI_SEARCH = 2;   // "/r" is for commands; "/ro" may already mean rocket

const emojiItem = ({ char, name, keywords }) => ({
  kind: 'emoji', id: `emoji:${char}`, char, label: name, keywords,
  run: (editor, range) => editor.chain().focus().insertContentAt(range, char).run(),
});

const emojiMatches = term => {
  const needle = term.trim().toLowerCase();
  return EMOJI.filter(e => !needle || `${e.name} ${e.keywords}`.includes(needle)).slice(0, EMOJI_LISTED).map(emojiItem);
};

/// What the menu lists for the text typed after the "/". `translate` turns a
/// catalog key into the label. Items: `{ kind, id, label, hint?, char?, run }`.
export function slashItems(query, translate) {
  const raw = query.toLowerCase();
  if (raw.startsWith(EMOJI_MODE)) return emojiMatches(raw.slice(EMOJI_MODE.length));
  const commands = SLASH_COMMANDS
    .filter(c => !raw || `${translate(c.labelKey)} ${c.keywords.join(' ')}`.toLowerCase().includes(raw))
    .map(c => ({ kind: 'command', id: c.id, label: translate(c.labelKey), hint: translate(c.hintKey), run: c.run }));
  if (commands.length || raw.length < MIN_EMOJI_SEARCH) return commands;
  return emojiMatches(raw);
}
