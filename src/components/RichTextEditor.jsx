import React, { useCallback, useEffect, useState } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import Image from '@tiptap/extension-image';
import {
  Bold, Italic, Underline as UnderlineIcon, Strikethrough,
  List, ListOrdered, Quote, Code, Link as LinkIcon, Undo, Redo, RemoveFormatting, SpellCheck
} from 'lucide-react';
import { useSettingsStore } from '../stores/settingsStore';
import { useSpellcheckStatus } from '../hooks/useSpellcheckStatus';
import { SpellcheckHelpDialog } from './SpellcheckHelpDialog';
import { t, useT  } from '../i18n/index.js';

function ToolbarButton({ onClick, active, disabled, title, children }) {
  return (
    <button
      type="button"
      onMouseDown={(e) => { e.preventDefault(); onClick(); }}
      disabled={disabled}
      title={title}
      className={`p-1.5 rounded transition-colors ${
        active
          ? 'bg-mail-accent/20 text-mail-accent-text'
          : 'text-mail-text-muted hover:bg-mail-surface-hover hover:text-mail-text'
      } ${disabled ? 'opacity-30 cursor-not-allowed' : ''}`}
    >
      {children}
    </button>
  );
}

function ToolbarDivider() {
  return <div className="w-px h-5 bg-mail-border mx-0.5" />;
}

function Toolbar({ editor }) {
  const t = useT();
  const spellcheckEnabled = useSettingsStore((s) => s.spellcheckEnabled ?? true);
  const setSpellcheckEnabled = useSettingsStore((s) => s.setSpellcheckEnabled);
  const spellcheckStatus = useSpellcheckStatus();
  const [helpOpen, setHelpOpen] = useState(false);

  // Linux with no dictionary installed: the attribute would still be written
  // and WebKit would still have nothing to check against, so the button stops
  // claiming to be a switch and becomes the way to fix it.
  const noDictionary = !!spellcheckStatus?.needsDictionary
    && spellcheckStatus.dictionaries.length === 0;

  const setLink = useCallback(() => {
    const previousUrl = editor.getAttributes('link').href;
    const url = window.prompt('URL', previousUrl || 'https://');
    if (url === null) return;
    if (url === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }
    editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
  }, [editor]);

  // The attribute lives on the wrapper below and the editable inherits it;
  // WebKit keeps painting the squiggles it already drew until the editable is
  // re-entered, so re-enter it.
  const toggleSpellcheck = useCallback(() => {
    setSpellcheckEnabled(!spellcheckEnabled);
    editor?.commands.blur();
    setTimeout(() => editor?.commands.focus(), 0);
  }, [editor, spellcheckEnabled, setSpellcheckEnabled]);

  const S = 15;

  if (!editor) return null;

  return (
    <div className="flex items-center gap-0.5 px-2 py-1 border-b border-mail-border bg-mail-surface/50 flex-wrap">
      <ToolbarButton onClick={() => editor.chain().focus().toggleBold().run()} active={editor.isActive('bold')} title={t('editor.boldCtrlB')}>
        <Bold size={S} />
      </ToolbarButton>
      <ToolbarButton onClick={() => editor.chain().focus().toggleItalic().run()} active={editor.isActive('italic')} title={t('editor.italicCtrlI')}>
        <Italic size={S} />
      </ToolbarButton>
      <ToolbarButton onClick={() => editor.chain().focus().toggleUnderline().run()} active={editor.isActive('underline')} title={t('editor.underlineCtrlU')}>
        <UnderlineIcon size={S} />
      </ToolbarButton>
      <ToolbarButton onClick={() => editor.chain().focus().toggleStrike().run()} active={editor.isActive('strike')} title={t('editor.strikethrough')}>
        <Strikethrough size={S} />
      </ToolbarButton>

      <ToolbarDivider />

      <ToolbarButton onClick={() => editor.chain().focus().toggleBulletList().run()} active={editor.isActive('bulletList')} title={t('editor.bulletList')}>
        <List size={S} />
      </ToolbarButton>
      <ToolbarButton onClick={() => editor.chain().focus().toggleOrderedList().run()} active={editor.isActive('orderedList')} title={t('editor.numberedList')}>
        <ListOrdered size={S} />
      </ToolbarButton>

      <ToolbarDivider />

      <ToolbarButton onClick={() => editor.chain().focus().toggleBlockquote().run()} active={editor.isActive('blockquote')} title={t('editor.blockquote')}>
        <Quote size={S} />
      </ToolbarButton>
      <ToolbarButton onClick={() => editor.chain().focus().toggleCodeBlock().run()} active={editor.isActive('codeBlock')} title={t('editor.codeBlock')}>
        <Code size={S} />
      </ToolbarButton>
      <ToolbarButton onClick={setLink} active={editor.isActive('link')} title={t('editor.insertLink')}>
        <LinkIcon size={S} />
      </ToolbarButton>

      <ToolbarDivider />

      <ToolbarButton onClick={() => editor.chain().focus().unsetAllMarks().clearNodes().run()} title={t('editor.clearFormatting')}>
        <RemoveFormatting size={S} />
      </ToolbarButton>
      <ToolbarButton onClick={() => editor.chain().focus().undo().run()} disabled={!editor.can().undo()} title={t('editor.undo')}>
        <Undo size={S} />
      </ToolbarButton>
      <ToolbarButton onClick={() => editor.chain().focus().redo().run()} disabled={!editor.can().redo()} title={t('editor.redo')}>
        <Redo size={S} />
      </ToolbarButton>

      <ToolbarDivider />

      <ToolbarButton
        onClick={noDictionary ? () => setHelpOpen(true) : toggleSpellcheck}
        active={!noDictionary && spellcheckEnabled}
        title={
          noDictionary
            ? t('editor.spellcheckNeedsDictionaryClickSee')
            : spellcheckEnabled ? t('editor.spellcheckClickTurnOff') : t('editor.spellcheckOffClickTurn')
        }
      >
        <SpellCheck size={S} />
      </ToolbarButton>

      <SpellcheckHelpDialog
        open={helpOpen}
        onClose={() => setHelpOpen(false)}
        confined={!!spellcheckStatus?.confined}
      />
    </div>
  );
}

const isImageFile = (f) => /^image\//.test(f.type || '');

const readAsDataUrl = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result);
  r.onerror = () => reject(r.error);
  r.readAsDataURL(file);
});

// ponytail: full-size data URIs in the document; resize/compress if large photos make typing lag.
async function insertImageFiles(editor, files, pos) {
  if (!files.length || !editor) return;
  const srcs = await Promise.all(files.map(readAsDataUrl));   // keep drop order
  // `alt` is the filename on purpose: the send-time extractor uses it as the MIME part filename.
  const nodes = srcs.map((src, i) => ({ type: 'image', attrs: { src, alt: files[i].name, title: files[i].name } }));
  editor.chain().focus().insertContentAt(pos, nodes).run();
}

export function RichTextEditor({ content, onUpdate, placeholder = 'Write your message...', editorRef, onFiles }) {
  const t = useT();
  const spellcheckEnabled = useSettingsStore((s) => s.spellcheckEnabled ?? true);
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: false,
      }),
      Underline,
      Link.configure({
        openOnClick: false,
        HTMLAttributes: { target: '_blank', rel: t('editor.noopenerNoreferrer') },
      }),
      Placeholder.configure({ placeholder }),
      // allowBase64: compose restores initialData.body HTML after minimize /
      // undo-send, and the inline picture must parse back out of that string.
      Image.configure({ allowBase64: true }),
    ],
    content,
    onUpdate: ({ editor }) => {
      onUpdate(editor.getHTML(), editor.getText());
    },
    editorProps: {
      attributes: {
        class: 'prose prose-sm max-w-none focus:outline-none h-full p-4 text-mail-text',
      },
      handleDrop: (view, event, _slice, moved) => {
        if (moved) return false;                                   // ProseMirror moving its own node — leave it alone
        const files = Array.from(event.dataTransfer?.files || []);
        if (!files.length) return false;                           // text/html drags: default ProseMirror handling
        // Claim the drop here: the compose modal has a fallback onDrop that attaches
        // anything that bubbles to it, and the images must not arrive there a second time.
        event.preventDefault();
        event.stopPropagation();
        const images = files.filter(isImageFile);
        const others = files.filter((f) => !isImageFile(f));
        const at = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? view.state.selection.to;
        insertImageFiles(editor, images, at);
        if (others.length) onFiles?.(others);
        return true;
      },
      handlePaste: (_view, event) => {
        const images = Array.from(event.clipboardData?.files || []).filter(isImageFile);
        if (!images.length) return false;
        insertImageFiles(editor, images, editor.state.selection.to);
        return true;
      },
    },
  });

  // Expose editor instance to parent
  useEffect(() => {
    if (editorRef) editorRef.current = editor;
  }, [editor, editorRef]);

  // Sync content from parent when it changes externally (mount, minimize/restore,
  // signature swap on account change, template fallback). None of that is a user
  // edit, so keep it out of the undo history — recorded, it lights Undo on an
  // empty message and makes the first Undo press a no-op.
  useEffect(() => {
    if (editor && content !== undefined && editor.getHTML() !== content) {
      editor.chain().setMeta('addToHistory', false).setContent(content).run();
    }
  }, [content, editor]);

  return (
    // spellCheck is inherited by the contenteditable below — ProseMirror never
    // sets the attribute itself, so nothing here overrides it.
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden bg-mail-bg" spellCheck={spellcheckEnabled}>
      <Toolbar editor={editor} />
      <div className="flex-1 overflow-y-auto">
        <EditorContent editor={editor} className="h-full" />
      </div>
    </div>
  );
}

// Convert plain text to basic HTML for initial editor content
export function textToHtml(text) {
  if (!text) return '';
  return text
    .split('\n')
    .map(line => `<p>${line || '<br>'}</p>`)
    .join('');
}

// Strip HTML to plain text (for text/ part of multipart emails).
// Block-level tags become newlines so paragraphs don't collapse into one line.
export function htmlToText(html) {
  if (!html) return '';
  const div = document.createElement('div');
  div.innerHTML = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|blockquote|pre|tr)>/gi, '\n');
  return (div.textContent || div.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
}

// The compose window renders paragraphs nearly flush (`.tiptap p { margin: 0 0
// 0.25em }` in index.css) but ships bare tags. Every reader — our own viewer
// included — then applies its default `p { margin: 1em 0 }`, so the message
// arrives with a blank line more between paragraphs than the window showed.
// Carry the editor's own spacing out with the message; inline, because mail
// clients drop <style> blocks. Blockquote is left out on purpose: its default
// `margin: 1em 40px` is the indent that makes a quote read as a quote.
const EDITOR_SPACING = {
  P: '0 0 0.25em',
  UL: '0.5em 0',
  OL: '0.5em 0',
  LI: '0.15em 0',
  PRE: '0.5em 0',
};

export function inlineComposeSpacing(html) {
  if (!html) return html;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.body.querySelectorAll(Object.keys(EDITOR_SPACING).join(',')).forEach((el) => {
    // A margin the message already carries is the author's, not ours.
    if (el.style.margin || el.style.marginTop || el.style.marginBottom) return;
    el.style.margin = EDITOR_SPACING[el.tagName];
  });
  return doc.body.innerHTML;
}
