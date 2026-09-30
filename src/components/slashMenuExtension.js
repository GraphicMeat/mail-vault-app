import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';

const key = new PluginKey('slashMenu');

// "/" then a word, at the start of a line or after a space (so "and/or" and a
// URL are left alone). "emoji " keeps its one space: what follows is a search.
const SLASH = /(?:^|\s)\/((?:emoji )?[^\s/]*)$/;

/// The "/query" the caret ends, or null: not in code, not with a selection.
export function findSlash(state) {
  const { selection } = state;
  if (!selection.empty) return null;
  const { $from } = selection;
  if ($from.parent.type.spec.code || !$from.parent.isTextblock) return null;
  if ($from.marks().some(mark => mark.type.name === 'code')) return null;
  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, '￼');
  const match = SLASH.exec(before);
  if (!match) return null;
  const query = match[1];
  return { query, from: $from.pos - query.length - 1, to: $from.pos };
}

function caretBox(view, pos) {
  try {
    const { left, bottom, top } = view.coordsAtPos(pos);
    return { left, top, bottom };
  } catch {
    // no layout (a test DOM): the editor's own corner
    const { left, top, bottom } = view.dom.getBoundingClientRect();
    return { left, top, bottom };
  }
}

/// The "/" command menu's trigger. It only finds the typed "/query" and reports
/// it (`onChange`, null when there is none); the menu itself, its list and what
/// each command does are the caller's. Escape closes the menu for that slash
/// until it is deleted or a new one is typed.
///
/// `onKey('down'|'up'|'enter'|'escape')` answers whether the menu took the key.
/// The keys are registered above the editor's own, so Enter picks a row rather
/// than splitting the line.
export const SlashMenu = Extension.create({
  name: 'slashMenu',
  priority: 1000,
  addOptions: () => ({ onChange: null, onKey: null }),

  addKeyboardShortcuts() {
    const send = name => () => {
      const active = key.getState(this.editor.state)?.active;
      return active ? !!this.options.onKey?.(name) : false;
    };
    return { ArrowDown: send('down'), ArrowUp: send('up'), Enter: send('enter'), Tab: send('enter'), Escape: send('escape') };
  },

  addProseMirrorPlugins() {
    const { options } = this;
    return [new Plugin({
      key,
      state: {
        init: () => ({ active: null, dismissed: null }),
        apply(tr, prev, _old, state) {
          const found = findSlash(state);
          const meta = tr.getMeta(key);
          let dismissed = meta?.dismiss ?? (prev.dismissed == null ? null : tr.mapping.map(prev.dismissed));
          if (!found) dismissed = null;                         // the slash is gone: a new one is a new ask
          const active = found && found.from !== dismissed ? found : null;
          return { active, dismissed };
        },
      },
      view: () => {
        let shown = null;
        return {
          update(view) {
            const { active } = key.getState(view.state);
            const same = shown && active && shown.from === active.from && shown.query === active.query;
            if (same) return;
            shown = active;
            options.onChange?.(active && { ...active, box: caretBox(view, active.from) });
          },
          destroy() { options.onChange?.(null); },
        };
      },
    })];
  },

  addCommands() {
    return {
      dismissSlashMenu: () => ({ tr, state, dispatch }) => {
        const active = key.getState(state)?.active;
        if (!active) return false;
        if (dispatch) dispatch(tr.setMeta(key, { dismiss: active.from }));
        return true;
      },
    };
  },
});
