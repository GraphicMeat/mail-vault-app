import React from 'react';
import { Sparkles, X } from 'lucide-react';
import { useT } from '../i18n/index.js';
import { useMailStore } from '../stores/mailStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useLifecycleStore, lifecycleInView, lifecycleKeys } from '../stores/lifecycleStore';
import { formatEmailDate } from '../utils/dateFormat';
import { listRowGround } from '../utils/listRowGround';

// The two-line row's height, so a pin is as tall as the compact rows under it
// (the same numbers FollowUpPinnedRows uses).
const PIN_HEIGHT = { comfortable: 52, compact: 44 };

/**
 * MailVault's own notes about Premium, pinned above an inbox list in the
 * views that pin follow-up reminders. Deliberately NOT rows of the list, for
 * the reason FollowUpPinnedRows gives: a list row is acted on by its
 * (account, folder, uid), and a note has none. A note has two actions: open
 * (the reader shows it) and dismiss.
 */
export function LifecyclePinnedRows({ hidden = false }) {
  const t = useT();
  const rows = useLifecycleStore((s) => s.rows);
  const openId = useLifecycleStore((s) => s.openId);
  const activeMailbox = useMailStore((s) => s.activeMailbox);
  const unifiedFolder = useMailStore((s) => s.unifiedFolder);
  const mailboxScope = useMailStore((s) => s.mailboxScope);
  const highlight = useSettingsStore((s) => s.emailRowHighlight);
  const dense = useSettingsStore((s) => s.listDensity) === 'compact';
  if (hidden) return null;
  const pinned = lifecycleInView({ activeMailbox, unifiedFolder, mailboxScope }, rows).filter((r) => lifecycleKeys(r.kind));
  if (!pinned.length) return null;

  const open = (row) => {
    // The reader shows one thing: leave the selected email so the note replaces it.
    useMailStore.setState({ selectedEmailId: null, selectedEmail: null, selectedEmailSource: null, selectedThread: null });
    useLifecycleStore.getState().open(row.id);
  };

  return (
    <div data-testid="lifecycle-pinned" role="list" aria-label={t('lifecycle.listTitle')}
      className="flex-shrink-0 border-b border-mail-border">
      {pinned.map((row) => {
        const unread = !row.seen;
        const selected = openId === row.id;
        const weight = unread ? 'font-semibold text-mail-text' : 'text-mail-text';
        return (
          <div key={row.id} role="listitem" data-testid="lifecycle-pinned-row" data-unread={String(unread)}
            aria-current={selected ? 'true' : undefined}
            style={{ position: 'relative', height: dense ? PIN_HEIGHT.compact : PIN_HEIGHT.comfortable }}
            onClick={() => open(row)}
            onKeyDown={(e) => {
              if (e.target !== e.currentTarget) return;
              if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(row); }
            }}
            tabIndex={0}
            className={`virtual-row row-compact row-top${dense ? ' row-dense' : ''} group relative flex gap-2 px-4 border-b border-mail-border last:border-b-0 cursor-pointer
              ${listRowGround({ highlight, selected, related: false, unread })}`}>
            <div className="row-gutter row-gutter-stacked">
              <div className="row-gutter-slot">
                <Sparkles size={14} aria-hidden="true" className={unread ? 'text-mail-accent-text' : 'text-mail-text-muted'} />
              </div>
            </div>
            <div className={`flex-1 min-w-0 ${dense ? 'py-0.5' : 'py-1.5'}`}>
              <div className="flex items-center gap-1.5">
                <span className={`truncate min-w-0 text-xs ${weight}`}>{t('lifecycle.from')}</span>
                <span className="text-xs text-mail-text-muted whitespace-nowrap ml-auto">
                  {formatEmailDate(new Date(row.atMs).toISOString())}
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <span dir="auto" className={`flex-1 min-w-0 truncate text-sm leading-snug ${weight}`}>
                  {t(lifecycleKeys(row.kind).subjectKey)}
                </span>
              </div>
            </div>
            <button type="button" data-testid="lifecycle-dismiss"
              aria-label={t('lifecycle.dismiss')} title={t('lifecycle.dismiss')}
              onClick={(e) => { e.stopPropagation(); useLifecycleStore.getState().dismiss(row.id); }}
              className="self-center flex-shrink-0 p-1 rounded text-mail-text-muted hover:text-mail-text hover:bg-mail-border">
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
