import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Smile, List, ListOrdered, Quote, SquareCode, Minus } from 'lucide-react';
import { Popover, MenuItem } from './ui/Popover';
import { useT } from '../i18n/index.js';
import { slashItems } from '../utils/slashCommands';

const ICONS = { emoji: Smile, bulletList: List, numberedList: ListOrdered, quote: Quote, codeBlock: SquareCode, divider: Minus };
const GAP = 4;

/// The list under the caret while a "/query" is typed in the message editor.
/// Keys arrive through `keysRef` (the editor owns the keyboard: focus never
/// leaves the text); a click on a row picks it.
export function SlashMenu({ editor, slash, keysRef }) {
  const t = useT();
  const items = useMemo(() => (slash ? slashItems(slash.query, t) : []), [slash?.query, t]);
  const [index, setIndex] = useState(0);
  const panel = useRef(null);
  useEffect(() => { setIndex(0); }, [slash?.from, slash?.query]);
  useEffect(() => { panel.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' }); }, [index, items]);
  const open = !!slash && items.length > 0;

  const pick = (item) => item?.run(editor, { from: slash.from, to: slash.to });
  const close = () => editor.commands.dismissSlashMenu();
  keysRef.current = (name) => {
    if (!open) return false;
    if (name === 'down') setIndex((index + 1) % items.length);
    else if (name === 'up') setIndex((index + items.length - 1) % items.length);
    else if (name === 'enter') pick(items[Math.min(index, items.length - 1)]);
    else close();
    return true;
  };

  return (
    <Popover ref={panel} open={open} onClose={close} role="listbox" aria-label={t('editor.slash.label')}
      className="max-h-[21rem] w-64 overflow-y-auto"
      style={open ? { top: slash.box.bottom + GAP, left: slash.box.left } : undefined}>
      {items.map((item, i) => {
        const Icon = ICONS[item.id];
        return (
          <MenuItem key={item.id} role="option" aria-selected={i === index}
            className={i === index ? 'bg-mail-surface-hover' : ''}
            onMouseDown={(event) => { event.preventDefault(); pick(item); }}
            onMouseMove={() => setIndex(i)}>
            {item.kind === 'emoji'
              ? <span aria-hidden="true" className="w-5 text-center">{item.char}</span>
              : <Icon size={16} aria-hidden="true" className="shrink-0 text-mail-text-muted" />}
            <span className="min-w-0">
              <span className="block truncate">{item.label}</span>
              {item.hint && <span className="block truncate text-xs text-mail-text-muted">{item.hint}</span>}
            </span>
          </MenuItem>
        );
      })}
    </Popover>
  );
}
