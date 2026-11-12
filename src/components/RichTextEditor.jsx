import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useEditor, EditorContent } from '@tiptap/react';
import {
  Bold, Italic, Underline as UnderlineIcon, Strikethrough,
  List, ListOrdered, Quote, Code, SquareCode, Link as LinkIcon, Undo, Redo, RemoveFormatting, SpellCheck,
  ExternalLink, Pencil, Unlink, Trash2, ImagePlus
} from 'lucide-react';
import { useSettingsStore } from '../stores/settingsStore';
import { useSpellcheckStatus } from '../hooks/useSpellcheckStatus';
import { SpellcheckHelpDialog } from './SpellcheckHelpDialog';
import { t, useT  } from '../i18n/index.js';
import { Popover, MenuItem } from './ui/Popover';
import { Button } from './ui/Button';
import { FIELD_TRIGGER } from './ui/field';
import { Z } from './ui/layers';
import { hasOpenDialog } from '../hooks/useDialogA11y';
import { linkRangeAt, applyLink, removeLink, removeLinkWithText, openLink } from '../utils/editorLinks';
import { imageList, resizedImage, scaleOffer } from '../utils/signatureImageScale';
import { ImageScaleDialog } from './ImageScaleDialog';
import { SlashMenu as SlashMenuTrigger } from './slashMenuExtension';
import { SlashMenu } from './SlashMenu';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { invoke } from '@tauri-apps/api/core';
import { toClientPoint, toAttachment } from '../utils/nativeDrop';
import { SIGNATURE_HTML_SELECTOR } from '../utils/htmlSignature';
import { editorExtensions, padEmptyLines } from '../utils/editorHtml';
export { editorExtensions, padEmptyLines, isPaddingBreak } from '../utils/editorHtml';
import { loadFontFacesForHtml } from '../services/fontService';

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

function Toolbar({ editor, onLink, onImage, sticky = false }) {
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

  // Just the preference. Retracting the underlines already on screen is the
  // editor's job, below — re-entering the editable does not do it, whatever
  // the previous comment here claimed.
  const toggleSpellcheck = useCallback(async () => {
    try {
      await setSpellcheckEnabled(!spellcheckEnabled);
    } catch {
      // Detached compose displays the bridge failure above the editor. The
      // local preference stays unchanged until main acknowledges it.
    }
  }, [spellcheckEnabled, setSpellcheckEnabled]);

  const S = 15;

  if (!editor) return null;

  return (
    <div data-testid="editor-toolbar"
      className={`flex items-center gap-0.5 px-2 py-1 border-b border-mail-border flex-wrap ${sticky ? 'sticky top-0 z-10 bg-mail-surface' : 'bg-mail-surface/50'}`}>
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
      <ToolbarButton onClick={() => editor.chain().focus().toggleCode().run()} active={editor.isActive('code')} title={t('editor.inlineCode')}>
        <Code size={S} />
      </ToolbarButton>
      <ToolbarButton onClick={() => editor.chain().focus().toggleCodeBlock().run()} active={editor.isActive('codeBlock')} title={t('editor.codeBlock')}>
        <SquareCode size={S} />
      </ToolbarButton>
      <ToolbarButton onClick={() => onLink()} active={editor.isActive('link')} title={t('editor.insertLink')}>
        <LinkIcon size={S} />
      </ToolbarButton>
      {onImage && (
        <ToolbarButton onClick={onImage} title={t('editor.insertImage')}>
          <ImagePlus size={S} />
        </ToolbarButton>
      )}

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

/**
 * Text and address of one link. Save goes through applyLink, whose setLink
 * refuses an address TipTap does not allow; the field is marked and the panel
 * stays open. Escape and an outside click cancel (Popover).
 */
function LinkPanel({ link, onSave, onRemove, onCancel }) {
  const t = useT();
  const [text, setText] = useState(link.text);
  const [href, setHref] = useState(link.href);
  const [invalid, setInvalid] = useState(false);
  const field = `${FIELD_TRIGGER} w-full mt-1`;
  return (
    <Popover
      open
      onClose={onCancel}
      variant="panel"
      handlesTab
      role="dialog"
      aria-label={t('editor.insertLink')}
      data-testid="link-editor"
      className="w-80 shadow-xl"
      style={{ top: link.top, left: link.left }}
    >
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => { e.preventDefault(); if (!onSave(text, href)) setInvalid(true); }}
      >
        <label className="text-xs text-mail-text-muted">
          {t('editor.link.text')}
          <input data-testid="link-editor-text" className={field} value={text} onChange={(e) => setText(e.target.value)} />
        </label>
        <label className="text-xs text-mail-text-muted">
          {t('editor.link.url')}
          <input
            data-testid="link-editor-url"
            className={`${field} ${invalid ? 'border-mail-danger' : ''}`}
            value={href}
            onChange={(e) => { setHref(e.target.value); setInvalid(false); }}
            aria-invalid={invalid || undefined}
            inputMode="url"
            autoFocus
            spellCheck={false}
          />
        </label>
        <div className="flex items-center gap-2 pt-1">
          {link.edit && (
            <Button variant="dangerTint" size="sm" data-testid="link-editor-remove" onClick={onRemove}>
              {t('editor.link.remove')}
            </Button>
          )}
          <span className="flex-1" />
          <Button size="sm" data-testid="link-editor-cancel" onClick={onCancel}>{t('common.cancel')}</Button>
          <Button variant="primary" size="sm" type="submit" data-testid="link-editor-save">{t('common.save')}</Button>
        </div>
      </form>
    </Popover>
  );
}

/** What a hovered link offers. Plain mouseover/mouseout drive it (the e2e harness has no pointer events). */
function LinkCard({ card, onAction, onEnter, onLeave }) {
  const t = useT();
  const item = (action, Icon, label, tone, disabled) => (
    <MenuItem data-link-action={action} tone={tone} disabled={disabled} onClick={() => onAction(action)}>
      <Icon size={14} aria-hidden="true" />{label}
    </MenuItem>
  );
  return createPortal(
    <div
      data-testid="link-card"
      role="menu"
      aria-label={card.href}
      className={`fixed ${hasOpenDialog() ? Z.dialogPopover : Z.popover} bg-mail-bg border border-mail-border rounded-lg py-1 min-w-[200px] max-w-[320px] shadow-xl`}
      style={{ top: card.top, left: card.left }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      <div className="px-3 pt-1 pb-1.5 text-xs text-mail-text-muted truncate" title={card.href}>{card.href}</div>
      {item('open', ExternalLink, t('editor.link.open'), undefined, !/^(https?:|mailto:)/i.test(card.href))}
      {item('edit', Pencil, t('editor.link.edit'))}
      {item('remove', Unlink, t('editor.link.remove'))}
      {item('remove-text', Trash2, t('editor.link.removeWithText'), 'danger')}
    </div>,
    document.body
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
/** Place already-encoded images (`{ src, name }`) at `pos`, or at the caret when `pos` is null. */
export function insertImages(editor, images, pos) {
  if (!images.length || !editor) return;
  // `alt` is the filename on purpose: the send-time extractor uses it as the MIME part filename.
  const nodes = images.map(({ src, name }) => ({ type: 'image', attrs: { src, alt: name, title: name } }));
  editor.chain().focus().insertContentAt(pos ?? editor.state.selection.to, nodes).run();
}

async function insertImageFiles(editor, files, pos) {
  if (!files.length || !editor) return;
  const srcs = await Promise.all(files.map(readAsDataUrl));   // keep drop order
  insertImages(editor, srcs.map((src, i) => ({ src, name: files[i].name })), pos);
}

/**
 * `imageTools`: a signature's editor. Adds the insert-image button and corner
 * handles on a picture, and after a resize offers the file at 3x its display
 * size (see ImageScaleDialog).
 */
export function RichTextEditor({ content, onUpdate, placeholder = 'Write your message...', editorRef, onFiles, placeCaret, imageTools = false, autoGrow = false }) {
  const t = useT();
  const [scaleOfferState, setScaleOffer] = useState(null);
  const pictures = useRef([]);
  const fileInput = useRef(null);
  const wrap = useRef(null);
  const [fileDrag, setFileDrag] = useState(false);
  const spellcheckEnabled = useSettingsStore((s) => s.spellcheckEnabled ?? true);
  const [card, setCard] = useState(null);          // hovered link: { a, href, top, left }
  const [linkEdit, setLinkEdit] = useState(null);  // link panel: { from, to, text, href, edit, top, left }
  const [slash, setSlash] = useState(null);         // the typed "/query": { query, from, to, box }
  const slashKeys = useRef(null);                   // the open menu's key handler, see SlashMenu
  const editor = useEditor({
    // Build the editor in useEditor's mount effect, never during render. Built
    // during render, @tiptap/react arms a 1 ms timer that destroys it unless
    // that effect runs first, trusting React to throw away a render whose store
    // changed meanwhile. React 18 skips that check when a Suspense boundary
    // reveals a tree it re-rendered hidden at default priority: the first
    // Compose of a session committed an editor the timer had already destroyed.
    // `editor` is null for the first render instead.
    immediatelyRender: false,
    extensions: [
      ...editorExtensions(placeholder, { resizeImages: imageTools }),
      SlashMenuTrigger.configure({ onChange: setSlash, onKey: (name) => slashKeys.current?.(name) ?? false }),
    ],
    content,
    // Fires once the instance above is actually built (never during render —
    // see the immediatelyRender note above). Reply/replyAll use `placeCaret`
    // to put the caret in the body instead of the To field (ComposeModal).
    onCreate: ({ editor }) => {
      if (imageTools) pictures.current = imageList(editor.state.doc);
      placeCaret?.(editor);
    },
    onUpdate: ({ editor }) => {
      setCard(null);
      if (imageTools) watchPictures(editor);
      onUpdate(padEmptyLines(editor.getHTML()));
    },
    editorProps: {
      attributes: {
        role: 'textbox',
        'aria-label': placeholder,
        'aria-multiline': 'true',
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

  // A signature editor takes pictures dropped from Finder. In the app a file
  // drag never reaches WebKit (see src/utils/nativeDrop.js): Tauri reports the
  // drop as paths plus the pointer position, and the editor under that point
  // claims it. Only pictures are taken.
  useEffect(() => {
    if (!imageTools || !editor || !window.__TAURI__ || document.body.dataset.mailvaultDemo === 'true') return undefined;
    let disposed = false;
    const stops = [];
    const onDrop = async ({ paths = [], position } = {}) => {
      setFileDrag(false);
      const point = toClientPoint(position, {
        dpr: window.devicePixelRatio, width: window.innerWidth, height: window.innerHeight,
      });
      const under = document.elementFromPoint(point.x, point.y);
      if (!paths.length || !under || !wrap.current?.contains(under) || editor.isDestroyed) return;
      try {
        const images = (await invoke('read_dropped_files', { paths })).map(toAttachment)
          .filter(record => record.contentType.startsWith('image/'))
          .map(record => ({ src: `data:${record.contentType};base64,${record.content}`, name: record.filename }));
        insertImages(editor, images, editor.view.posAtCoords({ left: point.x, top: point.y })?.pos ?? null);
      } catch { /* a file that cannot be read is not inserted */ }
    };
    const target = { target: getCurrentWebviewWindow().label };
    Promise.all([
      listen('tauri://drag-enter', () => setFileDrag(true), target),
      listen('tauri://drag-leave', () => setFileDrag(false), target),
      listen('tauri://drag-drop', (ev) => onDrop(ev.payload), target),
    ]).then((fns) => { if (disposed) fns.forEach(f => f()); else stops.push(...fns); }).catch(() => {});
    return () => { disposed = true; stops.forEach(f => f()); };
  }, [imageTools, editor]);

  // A picture whose display size just changed: is the file worth scaling to 3x?
  // The handles commit once, when the drag ends, so this is asked once per resize.
  function watchPictures(editor) {
    const next = imageList(editor.state.doc);
    const resized = resizedImage(pictures.current, next);
    pictures.current = next;
    if (resized) scaleOffer(resized).then(offer => { if (offer && !editor.isDestroyed) setScaleOffer(offer); });
  }

  const applyScale = () => {
    const offer = scaleOfferState;
    setScaleOffer(null);
    if (!offer || !editor) return;
    editor.commands.command(({ tr, state }) => {
      let done = false;
      state.doc.descendants((node, pos) => {
        if (!done && node.type.name === 'image' && node.attrs.src === offer.src) {
          tr.setNodeMarkup(pos, undefined, { ...node.attrs, src: offer.target.src });
          done = true;
        }
        return !done;
      });
      return done;
    });
  };

  // Expose editor instance to parent
  useEffect(() => {
    if (editorRef) editorRef.current = editor;
  }, [editor, editorRef]);

  // Make the switch mean something for words already on screen.
  //
  // WebKit binds a spelling marker to the TEXT NODE, so changing an attribute
  // never retracts one that is already painted. Measured on the runner against
  // a marked sentence (red pixels, 3993 = marked, 3527 = clean): wrapper
  // attribute + blur/focus 3993, `spellcheck=false` on the editable itself
  // 3993, a `contenteditable` off/on cycle 3993 — and replacing the nodes,
  // 3527. Only the last one clears.
  //
  // In an effect, not in the click handler: the handler runs BEFORE React has
  // written the new attribute, so nodes rebuilt there are created while
  // checking is still on, get marked again on the spot, and the switch looks
  // just as broken. `addToHistory: false` keeps Undo out of it — the same
  // idiom the external-content sync below uses — and the selection goes back
  // because the document is identical, so the positions still hold.
  // Padded, or a line break ending a paragraph would not survive the re-read.
  // A destroyed editor has no schema left to write HTML with.
  const spellcheckSettled = useRef(false);
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    if (!spellcheckSettled.current) { spellcheckSettled.current = true; return; }
    const { from, to } = editor.state.selection;
    editor.chain()
      .setMeta('addToHistory', false)
      .setContent(padEmptyLines(editor.getHTML()))
      .setTextSelection({ from, to })
      .run();
  }, [spellcheckEnabled, editor]);

  // Sync content from parent when it changes externally (mount, minimize/restore,
  // signature swap on account change, template fallback). None of that is a user
  // edit, so keep it out of the undo history — recorded, it lights Undo on an
  // empty message and makes the first Undo press a no-op.
  // The parent holds the padded HTML this editor handed it; that echo is not a change.
  // Replacing the document leaves the caret at its end, below the signature and
  // any quote, so `placeCaret` puts it back unless the person is typing in
  // another field. The editor is usually built on the empty pre-init form: a
  // reply's body arrives here after onCreate placed the caret, and before
  // TipTap's deferred focus, so the editor cannot be asked whether it has it.
  // An empty body on an empty editor is no change either: syncing it placed the
  // caret a second time, and that deferred focus could land in another field.
  useEffect(() => {
    if (editor && !editor.isDestroyed && content !== undefined && !(content === '' && editor.isEmpty)
      && padEmptyLines(editor.getHTML()) !== content) {
      editor.chain().setMeta('addToHistory', false).setContent(content).run();
      // An external swap is not a resize: the next drag compares against this.
      if (imageTools) pictures.current = imageList(editor.state.doc);
      const active = document.activeElement;
      if (placeCaret && !(active && !editor.view.dom.contains(active)
        && active.matches?.('input, textarea, select, [contenteditable="true"]'))) placeCaret(editor);
    }
  }, [content, editor]);

  // A downloaded Google font the content is written in draws in it here
  // (services/fontService.js); anything else draws in its fallback.
  useEffect(() => { void loadFontFacesForHtml(content); }, [content]);

  // The link button and the card's Edit. With no range given, the link the
  // caret is in (or just after); a selection counts only when it lies inside
  // that link, otherwise its text becomes the new link's text.
  const openLinkEditor = useCallback((range) => {
    if (!editor) return;
    setCard(null);
    const { from, to, empty } = editor.state.selection;
    let link = range;
    if (!link) {
      const at = linkRangeAt(editor, from);
      link = at && (empty || (from >= at.from && to <= at.to)) ? at : null;
    }
    const text = editor.state.doc.textBetween(from, to, ' ');
    // A selection with no text in it (a picture) is kept: the link goes after it.
    const target = link || (text ? { from, to, href: '', text } : { from: to, to, href: '', text: '' });
    let place = { top: 120, left: 120 };
    try {
      const c = editor.view.coordsAtPos(target.from);
      place = { top: c.bottom + 6, left: c.left };
    } catch { /* not laid out: the Popover keeps it on screen */ }
    setLinkEdit({ ...target, edit: !!link, ...place });
  }, [editor]);

  const closeLinkEditor = useCallback(() => {
    setLinkEdit(null);
    editor?.commands.focus();
  }, [editor]);

  const hideTimer = useRef(null);
  useEffect(() => () => clearTimeout(hideTimer.current), []);
  const keepCard = () => clearTimeout(hideTimer.current);
  // Long enough for the pointer to travel from the link onto the card.
  const hideCardSoon = () => { keepCard(); hideTimer.current = setTimeout(() => setCard(null), 300); };
  // Not a link in an HTML signature: it is no link mark the card could edit.
  const linkIn = (e) => {
    const a = e.target.closest?.('.ProseMirror a[href]');
    return a && !a.closest(SIGNATURE_HTML_SELECTOR) ? a : null;
  };
  const onMouseOver = (e) => {
    const a = linkIn(e);
    if (!a || linkEdit) return;
    keepCard();
    const r = a.getBoundingClientRect();
    setCard((c) => (c?.a === a ? c : { a, href: a.getAttribute('href') || '', top: r.bottom + 4, left: r.left }));
  };
  const onMouseOut = (e) => {
    const a = linkIn(e);
    if (a && !a.contains(e.relatedTarget)) hideCardSoon();
  };

  const onCardAction = (action) => {
    const { a, href } = card || {};
    setCard(null);
    if (action === 'open') { openLink(href); return; }
    let range = null;
    try { range = a?.isConnected ? linkRangeAt(editor, editor.view.posAtDOM(a, 0)) : null; } catch { range = null; }
    if (!range) return;
    if (action === 'edit') { openLinkEditor(range); return; }
    if (action === 'remove') removeLink(editor, range);
    else removeLinkWithText(editor, range);
    editor.commands.focus();
  };

  return (
    // spellCheck is inherited by the contenteditable below — ProseMirror never
    // sets the attribute itself, so nothing here overrides it.
    <div ref={wrap} data-file-drag={fileDrag || undefined}
      className={`flex flex-col bg-mail-bg ${autoGrow ? 'flex-1' : 'flex-1 min-h-0 overflow-hidden'} ${fileDrag ? 'ring-2 ring-inset ring-mail-accent' : ''}`}
      spellCheck={spellcheckEnabled}>
      <Toolbar sticky={autoGrow} editor={editor} onLink={openLinkEditor} onImage={imageTools ? () => fileInput.current?.click() : undefined} />
      {imageTools && (
        <input ref={fileInput} type="file" accept="image/*" multiple className="hidden" tabIndex={-1}
          data-testid="editor-image-input" aria-hidden="true"
          onChange={(event) => {
            const files = Array.from(event.target.files || []).filter(isImageFile);
            event.target.value = '';
            insertImageFiles(editor, files, null);
          }} />
      )}
      <ImageScaleDialog offer={scaleOfferState} onScale={applyScale} onKeep={() => setScaleOffer(null)} />
      <div className={autoGrow ? 'flex-1' : 'flex-1 overflow-y-auto'} onMouseOver={onMouseOver} onMouseOut={onMouseOut}>
        <EditorContent editor={editor} className="h-full" />
      </div>
      {editor && <SlashMenu editor={editor} slash={slash} keysRef={slashKeys} />}
      {card && <LinkCard card={card} onAction={onCardAction} onEnter={keepCard} onLeave={hideCardSoon} />}
      {linkEdit && (
        <LinkPanel
          link={linkEdit}
          onCancel={closeLinkEditor}
          onRemove={() => { removeLink(editor, linkEdit); closeLinkEditor(); }}
          onSave={(text, href) => {
            if (!applyLink(editor, linkEdit, { text, href })) return false;
            closeLinkEditor();
            return true;
          }}
        />
      )}
    </div>
  );
}

export { textToHtml } from '../utils/textToHtml';
export { htmlToText, inlineComposeSpacing } from '../utils/editorHtml';
