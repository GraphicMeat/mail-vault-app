import React, { useRef, useState } from 'react';
import { Check, FolderDown, CalendarRange } from 'lucide-react';
import { Popover } from './ui/Popover';
import { wedgeClip, radialContentPosition } from './QuickActions';
import { useViewStore, viewLabel } from '../stores/viewStore';
import { downloadChoices, narrowDef } from '../utils/viewRange';
import { exportFolderName } from './email/AttachmentBar';
import { getLocale, useT } from '../i18n/index.js';
import '../styles/quick-actions.css';

const WHEEL = 240;

/// "Download attachments" for a view — or a search — that filters on them. A
/// view's window across two calendar months asks which part, on the same wheel
/// the quick actions use; anything else downloads everything at once. A search
/// passes its `rows` and a `name` instead of a view.
export function ViewAttachmentsDownload({ view, rows, name }) {
  const t = useT();
  const exportAttachments = useViewStore(state => state.exportAttachments);
  const exportRowAttachments = useViewStore(state => state.exportRowAttachments);
  const buttonRef = useRef(null);
  const [menu, setMenu] = useState(null);
  const [active, setActive] = useState(0);
  const [state, setState] = useState(null);

  const monthName = date => new Intl.DateTimeFormat(getLocale(), {
    month: 'long', ...(date.getFullYear() !== new Date().getFullYear() && { year: 'numeric' }),
  }).format(date);
  const labelOf = choice => (choice.key === 'all' ? t('views.download.all') : monthName(choice.month));

  const run = async choice => {
    setMenu(null);
    setState({ busy: true });
    try {
      const folder = [view ? viewLabel(view, t) : name, choice.month && monthName(choice.month)].filter(Boolean).join(' ');
      const { downloadDir, join } = await import('@tauri-apps/api/path');
      const destDir = await join(await downloadDir(), exportFolderName(folder, t('email.attachments.folderName')));
      const result = view
        ? await exportAttachments(narrowDef(view.def, choice), destDir)
        : await exportRowAttachments(rows || [], destDir);
      // A search can hold server hits the vault never stored; "none found"
      // would be a false answer for those.
      const found = result?.files ? t('views.download.done', { count: result.files }) : !result?.skipped && t('views.download.none');
      const missed = result?.skipped && t('views.download.skipped', { count: result.skipped });
      setState({ done: [found, missed].filter(Boolean).join(' · ') });
      if (result?.files) await window.__TAURI__?.core?.invoke('show_in_folder', { path: result.dir }).catch(() => {});
    } catch (error) {
      console.error('[views] attachment download failed:', error);
      setState({ done: t('email.attachments.failedDownload'), error: true });
    }
    setTimeout(() => setState(null), 6000);
  };

  const open = () => {
    const choices = view && downloadChoices(view.def);
    if (!choices) return run({ key: 'all' });
    const rect = buttonRef.current.getBoundingClientRect();
    setActive(0);
    setMenu({ choices, top: rect.bottom + 6, left: rect.left + rect.width / 2 - WHEEL / 2 });
  };

  /// Arrow keys go round the wheel, the way they go down a menu.
  const moveFocus = event => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    const items = [...event.currentTarget.querySelectorAll('[role="menuitem"]')];
    items[(items.indexOf(document.activeElement) + step + items.length) % items.length]?.focus();
  };

  const current = menu?.choices[active];
  return <>
    <button ref={buttonRef} type="button" data-testid="view-download-attachments" className="mail-toolbar-button shrink-0"
      disabled={!!state?.busy} aria-haspopup="menu" aria-expanded={!!menu} onClick={open}
      title={t('views.download.title')}>
      {state?.done && !state.error ? <Check size={14} /> : <FolderDown size={14} className={state?.busy ? 'animate-pulse' : undefined} />}
      <span className={state?.error ? 'text-mail-danger' : undefined}>{state?.done || t('views.download.title')}</span>
    </button>
    <Popover open={!!menu} onClose={() => setMenu(null)} role="menu" aria-label={t('views.download.title')} onKeyDown={moveFocus}
      className="quick-actions-radial" data-testid="view-download-wheel"
      style={{ top: menu?.top || 0, left: menu?.left || 0, width: WHEEL, height: WHEEL }}>
      {menu?.choices.map((choice, index) => <button key={choice.key} type="button" role="menuitem"
        className="quick-action-radial-item" data-choice={choice.key} aria-label={labelOf(choice)}
        autoFocus={index === 0} aria-current={index === active ? 'true' : undefined}
        style={{ clipPath: wedgeClip(index, menu.choices.length) }}
        onMouseEnter={() => setActive(index)} onFocus={() => setActive(index)} onClick={() => run(choice)}>
        <span className="quick-action-radial-content" style={radialContentPosition(index, menu.choices.length)}>
          {choice.key === 'all' ? <FolderDown size={19} aria-hidden="true" /> : <CalendarRange size={19} aria-hidden="true" />}
        </span>
      </button>)}
      {current && <div className="quick-actions-radial-center" aria-live="polite">
        <span>{labelOf(current)}</span>
      </div>}
    </Popover>
  </>;
}
