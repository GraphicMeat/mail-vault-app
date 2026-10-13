import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../../i18n/index.js';
import { useViewStore } from '../../stores/viewStore';
import { useViewportShift } from '../../hooks/useViewportShift';
import { hasOpenDialog, registerPopoverLayer } from '../../hooks/useDialogA11y';
import { Private } from '../privacy/Private';
import { PrivateWord } from '../privacy/PrivateWord';
import { Z } from '../ui/layers';

/// Senders and subjects a card lists. The daemon caps its reply at the same
/// number; the card does not trust that.
const TOP = 10;
/// How long a card rests on one word before asking the daemon about it.
const FETCH_DELAY = 150;

/**
 * Who sends a word and the subjects it turns up in, across the person's mail,
 * floating beside the keyword chip it belongs to.
 *
 * Not a `Popover`: that one lays a click-catcher over the window, and a
 * hovercard must let the pointer go straight on to the next chip. Not a
 * `StateTooltip` either: the pointer has to be able to rest on the card.
 *
 * The panel owns the timing (when to open, the grace before closing); this
 * card owns the fetch. It stays mounted while closed, so each word is asked
 * for once per panel: `details` is the cache. It fetches only once opened and
 * resting on a word (`FETCH_DELAY`), so neither a pointer sweeping across the
 * chips nor Tab walking along them asks about every word passed.
 */
export function KeywordHovercard({ id, term, anchorEl, open, onEnter, onLeave, onClose }) {
  const t = useT();
  const loadKeywordDetail = useViewStore(state => state.loadKeywordDetail);
  const [details, setDetails] = useState({});
  const asked = useRef(new Set());
  const mounted = useRef(false);
  const cardRef = useRef(null);
  const [pos, setPos] = useState(null);

  // Set in the body, not only at creation: StrictMode runs this effect's
  // cleanup and then the effect again, and a flag left false drops every reply.
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  // Asked a beat after the card opens or moves to another word: tabbing along
  // the chips opens each card at once, and must not ask about each one.
  useEffect(() => {
    if (!open || !term || asked.current.has(term)) return undefined;
    const timer = setTimeout(() => {
      asked.current.add(term);
      Promise.resolve()
        .then(() => loadKeywordDetail(term))
        .then(
          reply => { if (mounted.current) setDetails(all => ({ ...all, [term]: { status: 'ready', reply } })); },
          () => {
            // A failed ask may be asked again the next time the card opens.
            asked.current.delete(term);
            if (mounted.current) setDetails(all => ({ ...all, [term]: { status: 'error' } }));
          },
        );
    }, FETCH_DELAY);
    return () => clearTimeout(timer);
  }, [open, term, loadKeywordDetail]);

  useLayoutEffect(() => {
    if (!open || !anchorEl) { setPos(null); return; }
    const r = anchorEl.getBoundingClientRect();
    setPos({ top: r.bottom + 6, left: r.left });
  }, [open, anchorEl, term]);

  useViewportShift(cardRef, open && !!pos, [pos?.top, pos?.left]);

  // Escape peels this card first, before the reader's own Escape sees it.
  const close = useCallback(() => onClose?.(), [onClose]);
  useEffect(() => (open ? registerPopoverLayer(close) : undefined), [open, close]);

  // A scroll anywhere but in the card moves the chip out from under it.
  useEffect(() => {
    if (!open) return undefined;
    const onScroll = (event) => {
      if (cardRef.current && event.target instanceof Node && cardRef.current.contains(event.target)) return;
      close();
    };
    document.addEventListener('scroll', onScroll, true);
    return () => document.removeEventListener('scroll', onScroll, true);
  }, [open, close]);

  if (!open || !term || !pos) return null;

  const entry = details[term];
  const reply = entry?.status === 'ready' ? entry.reply : null;
  const senders = (reply?.senders || []).slice(0, TOP);
  const subjects = (reply?.subjects || []).slice(0, TOP);
  const layer = hasOpenDialog() ? Z.dialogPopover : Z.popover;

  let body;
  if (!entry) {
    body = <p className="text-xs text-mail-text-muted">{t('viewBuilder.detailLoading')}</p>;
  } else if (entry.status === 'error') {
    body = <p className="text-xs text-mail-text-muted">{t('viewBuilder.detailError')}</p>;
  } else if (!reply?.available) {
    body = <p className="text-xs text-mail-text-muted">{t('viewBuilder.detailUnavailable')}</p>;
  } else if (!senders.length && !subjects.length) {
    body = <p className="text-xs text-mail-text-muted">{t('common.noMatches')}</p>;
  } else {
    body = <>
      {senders.length > 0 && <section>
        <h4 className="text-[11px] font-medium uppercase tracking-wide text-mail-text-muted mb-1">{t('viewBuilder.topSenders')}</h4>
        <ul className="space-y-0.5">
          {senders.map((sender, i) => (
            <li key={`${sender.address}-${i}`} data-testid="keyword-hovercard-sender" className="flex items-baseline gap-2 min-w-0 text-xs">
              <span className="truncate min-w-0 text-mail-text">
                {sender.name ? <Private kind="name">{sender.name}</Private> : <Private kind="email">{sender.address}</Private>}
              </span>
              {sender.name && sender.address && (
                <span className="truncate min-w-0 text-mail-text-muted"><Private kind="email">{sender.address}</Private></span>
              )}
              <span className="ml-auto shrink-0 tabular-nums text-mail-text-muted">{sender.count}</span>
            </li>
          ))}
        </ul>
      </section>}
      {subjects.length > 0 && <section className={senders.length ? 'mt-2.5' : ''}>
        <h4 className="text-[11px] font-medium uppercase tracking-wide text-mail-text-muted mb-1">{t('viewBuilder.topSubjects')}</h4>
        <ul className="space-y-0.5">
          {subjects.map((item, i) => (
            <li key={`${item.subject}-${i}`} data-testid="keyword-hovercard-subject" className="flex items-baseline gap-2 min-w-0 text-xs">
              <span className="truncate min-w-0 text-mail-text"><Private kind="text">{item.subject}</Private></span>
              <span className="ml-auto shrink-0 tabular-nums text-mail-text-muted">{item.count}</span>
            </li>
          ))}
        </ul>
      </section>}
    </>;
  }

  return createPortal(
    <div
      ref={cardRef}
      data-testid="keyword-hovercard"
      data-capture-exclude=""
      id={id}
      role="tooltip"
      className={`fixed ${layer} w-72 max-w-[calc(100vw-16px)] max-h-[60vh] overflow-y-auto bg-mail-bg border border-mail-border rounded-lg shadow-lg p-3`}
      style={pos}
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
    >
      <p className="text-sm font-semibold text-mail-text mb-2 truncate"><PrivateWord word={term} /></p>
      {body}
    </div>,
    document.body,
  );
}
