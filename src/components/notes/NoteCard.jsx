import React, { useEffect, useRef, useState } from 'react';
import { Check, Copy, ExternalLink, Paperclip, Star, Trash2 } from 'lucide-react';
import { send } from '../../services/transport';
import { getCleanBase64 } from '../../services/attachmentUtils';
import { useT, getLocale } from '../../i18n';

const locale = () => (getLocale() === 'zh-Hans' ? 'zh-CN' : getLocale());

/// A link's host without the `www.`, once per host. A string that is not a URL
/// shows nothing rather than itself.
export function linkDomains(links = []) {
  const out = [];
  for (const link of links) {
    try {
      const host = new URL(link).hostname.replace(/^www\./i, '');
      if (host && !out.includes(host)) out.push(host);
    } catch { /* not a URL */ }
  }
  return out;
}

/// The first photo of a card, read from the copy this computer already holds
/// once the card is on screen, never from the server: scrolling the board
/// must not download whole messages. No local copy, no preview; the file
/// name in the attachment list stands in.
function PhotoThumb({ copy, attachment }) {
  const [src, setSrc] = useState(null);
  const ref = useRef(null);
  useEffect(() => {
    let live = true;
    const load = () => send('maildir_read_attachment', {
      accountId: copy.accountId, mailbox: copy.mailbox, uid: copy.uid, attachmentIndex: attachment.partIndex, localOnly: true,
    }).then(b64 => {
      if (live && typeof b64 === 'string' && b64) setSrc(`data:${attachment.mime};base64,${getCleanBase64(b64)}`);
    }).catch(() => {});
    // ponytail: no observer in jsdom or an old WebView, so the read runs at
    // once there; a board of many photo notes is the case the observer is for.
    if (typeof IntersectionObserver === 'undefined' || !ref.current) { load(); return () => { live = false; }; }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { observer.disconnect(); load(); }
    });
    observer.observe(ref.current);
    return () => { live = false; observer.disconnect(); };
  }, [copy.accountId, copy.mailbox, copy.uid, attachment.partIndex, attachment.mime]);
  return <span ref={ref} className="block">
    {src && <img src={src} alt={attachment.name} data-testid="note-thumb"
      className="w-full max-h-32 object-cover rounded-md border border-mail-border" />}
  </span>;
}

export default function NoteCard({
  card, account, color, col, row, active, canStar, canDelete, busy = false,
  onFocus, onOpen, onCopyLink, onOpenLink, onStar, onDone, onDelete,
}) {
  const t = useT();
  const domains = linkDomains(card.links);
  const photo = (card.attachments || []).find(attachment => String(attachment.mime || '').startsWith('image/'));
  const date = card.date ? new Date(card.date * 1000).toLocaleDateString(locale(), { year: 'numeric', month: 'short', day: 'numeric' }) : '';
  const subject = card.subject || t('common.noSubject');
  // The card's own actions never open it.
  const act = handler => event => { event.stopPropagation(); handler?.(card); };
  const hasLink = card.links?.length > 0;

  return <article
    data-testid="note-card" data-note-card data-key={card.key} data-col={col} data-row={row}
    data-starred={card.starred ? 'true' : undefined} aria-busy={busy || undefined}
    tabIndex={active ? 0 : -1} aria-label={subject}
    onFocus={event => { if (event.target === event.currentTarget) onFocus?.(); }}
    onClick={() => onOpen?.(card)}
    onKeyDown={event => {
      if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
      event.preventDefault();
      onOpen?.(card);
    }}
    className="group flex flex-col gap-2 p-3 rounded-lg border border-mail-border bg-mail-surface cursor-pointer
      hover:border-mail-accent/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-mail-accent">
    <div className="flex items-start gap-2">
      <h3 className="flex-1 min-w-0 text-sm font-semibold text-mail-text break-words" data-testid="note-subject">{subject}</h3>
      {card.starred && <Star size={14} className="shrink-0 text-mail-warning fill-current" aria-hidden="true" />}
    </div>
    {card.snippet && <p className="text-xs text-mail-text-muted line-clamp-3 break-words" data-testid="note-snippet">{card.snippet}</p>}
    {photo && <PhotoThumb copy={card.copies[0]} attachment={photo} />}
    {domains.length > 0 && <ul className="flex flex-wrap gap-1" aria-label={t('notes.links')}>
      {domains.map(host => <li key={host} data-testid="note-domain"
        className="px-1.5 py-0.5 rounded bg-mail-accent/10 text-mail-accent-text text-[11px]">{host}</li>)}
    </ul>}
    {card.attachments?.length > 0 && <ul className="flex flex-col gap-0.5" aria-label={t('notes.attachments')}>
      {card.attachments.map(attachment => <li key={attachment.partIndex} data-testid="note-attachment"
        className="flex items-center gap-1 text-[11px] text-mail-text-muted min-w-0">
        <Paperclip size={11} aria-hidden="true" className="shrink-0" /><span className="truncate">{attachment.name}</span>
      </li>)}
    </ul>}
    <div className="flex items-center gap-1.5 text-[11px] text-mail-text-muted">
      <span className="w-2 h-2 rounded-full shrink-0" data-testid="note-account-dot"
        style={{ backgroundColor: color }} title={account?.email} aria-label={account?.email} role="img" />
      <time dateTime={card.date ? new Date(card.date * 1000).toISOString() : undefined} className="flex-1">{date}</time>
      <span className="flex items-center gap-0.5 opacity-70 group-hover:opacity-100 group-focus-within:opacity-100">
        {hasLink && <button type="button" className="p-1 rounded hover:bg-mail-surface-hover" data-testid="note-copy-link"
          title={t('notes.copyLink')} aria-label={t('notes.copyLink')} onClick={act(onCopyLink)}><Copy size={13} /></button>}
        {hasLink && <button type="button" className="p-1 rounded hover:bg-mail-surface-hover" data-testid="note-open-link"
          title={t('notes.openLink')} aria-label={t('notes.openLink')} onClick={act(onOpenLink)}><ExternalLink size={13} /></button>}
        <button type="button" className="p-1 rounded hover:bg-mail-surface-hover" data-testid="note-star"
          disabled={!canStar || busy} aria-pressed={!!card.starred}
          title={card.starred ? t('notes.unstar') : t('notes.star')} aria-label={card.starred ? t('notes.unstar') : t('notes.star')}
          onClick={act(onStar)}><Star size={13} className={card.starred ? 'fill-current text-mail-warning' : ''} /></button>
        <button type="button" className="p-1 rounded hover:bg-mail-surface-hover" data-testid="note-done"
          disabled={busy} title={t('notes.markDone')} aria-label={t('notes.markDone')} onClick={act(onDone)}><Check size={13} /></button>
        <button type="button" className="p-1 rounded hover:bg-mail-surface-hover text-mail-danger" data-testid="note-delete"
          disabled={!canDelete || busy} title={t('common.delete')} aria-label={t('common.delete')} onClick={act(onDelete)}><Trash2 size={13} /></button>
      </span>
    </div>
  </article>;
}
