import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { Check, Paperclip, X } from 'lucide-react';
import { senderChoices, senderState } from '../../utils/senderRules';
import { useT } from '../../i18n/index.js';
import { useViewStore, viewLabel, viewQueryIsEmpty, MAX_FREE_VIEWS } from '../../stores/viewStore';
import { useSettingsStore, hasPremiumAccess } from '../../stores/settingsStore';
import { Button } from '../ui/Button';
import { Combobox } from '../ui/Combobox';
import { KeywordHovercard } from './KeywordHovercard';
import { usePrivateWord } from '../privacy/PrivateWord';

/// Hover this long on a chip before its card opens: a pointer crossing the row
/// opens nothing, and asks the daemon nothing.
const OPEN_DELAY = 250;
/// The card survives the pointer's trip from the chip onto it.
const CLOSE_GRACE = 150;

/// The rows, in the order they are offered: what names a mail best first.
const KINDS = [
  { kind: 'identifier', labelKey: 'viewBuilder.identifiers' },
  { kind: 'phrase', labelKey: 'viewBuilder.phrases' },
  { kind: 'word', labelKey: 'viewBuilder.words' },
];

const NOTICE_KEYS = {
  added: 'viewBuilder.added', created: 'viewBuilder.created', keptOut: 'viewBuilder.keptOut', blocked: 'viewBuilder.blocked',
  saveFailed: 'viewBuilder.saveFailed',
};
const GOOD_NOTICES = ['added', 'created', 'keptOut', 'blocked'];

/**
 * One word to pick. Masked by privacy mode, its name is the filler on screen:
 * the masked run is aria-hidden, and the word itself must never be the name.
 */
function KeywordChip({ term, checked, fromAttachment, attachmentLabel, describedBy, ...handlers }) {
  const { text, masked } = usePrivateWord(term);
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={masked ? text : undefined}
      aria-describedby={describedBy}
      {...handlers}
      className={`inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded-full border transition-colors ${checked
        ? 'border-mail-accent bg-mail-accent/10 text-mail-accent-text'
        : 'border-mail-border bg-mail-surface text-mail-text hover:bg-mail-surface-hover'}`}
    >
      {checked && <Check size={11} aria-hidden="true" />}
      {masked ? <span className="mv-private" aria-hidden="true">{text}</span> : text}
      {fromAttachment && <Paperclip size={11} className="text-mail-text-muted" aria-label={attachmentLabel} role="img" />}
    </button>
  );
}

/**
 * One sender or domain to pick, shaped like a word chip. A domain has no
 * address of its own for privacy mode to recognise, so it is masked the way
 * the address it came from is: the part after the `@`. The test id is the
 * position, never the address, which would leak the sender into the page.
 */
function SenderChip({ value, address, index, checked, ...handlers }) {
  const full = usePrivateWord(address);
  const text = !full.masked ? value : value.includes('@') ? full.text : full.text.slice(full.text.indexOf('@') + 1);
  const masked = full.masked;
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={masked ? text : undefined}
      data-testid={`view-builder-sender-${index}`}
      {...handlers}
      className={`inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded-full border transition-colors ${checked
        ? 'border-mail-accent bg-mail-accent/10 text-mail-accent-text'
        : 'border-mail-border bg-mail-surface text-mail-text hover:bg-mail-surface-hover'}`}
    >
      {checked && <Check size={11} aria-hidden="true" />}
      {masked ? <span className="mv-private" aria-hidden="true">{text}</span> : text}
    </button>
  );
}

/** A sender's address in a list, masked in privacy mode like every other name. */
function PrivateAddress({ value }) {
  const { text, masked } = usePrivateWord(value);
  return masked ? <span className="mv-private" aria-label={text}>{text}</span> : <>{text}</>;
}

/**
 * The open email's distinctive words as chips, to be added to a saved view or
 * made into a new one. The words and what they find come from the daemon
 * (`loadKeywords`, `loadKeywordDetail`); this panel only picks among them.
 *
 * Loaded when the email changes, by its identity rather than its object: the
 * row is replaced on every store update and must not reload the words.
 */
export function ViewBuilderPanel({ email, accountId, mailbox, onClose }) {
  const t = useT();
  const views = useViewStore(state => state.views);
  const loadKeywords = useViewStore(state => state.loadKeywords);
  const addTermsToView = useViewStore(state => state.addTermsToView);
  const createViewFromTerms = useViewStore(state => state.createViewFromTerms);
  const premium = useSettingsStore(state => hasPremiumAccess(state.billingProfile));
  // Reading attachment text is the Premium "Index attachment text" feature:
  // the same switch and plan gate as the index's own.
  const readAttachments = useSettingsStore(state => !!state.searchIndexAttachments && hasPremiumAccess(state.billingProfile));

  const [load, setLoad] = useState({ status: 'loading', keywords: [] });
  // The attachments' words come in a second answer; until it lands the chips
  // from the body are already on screen.
  const [readingAttachments, setReadingAttachments] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [pickedSenders, setPickedSenders] = useState(() => new Set());
  const [whoOpen, setWhoOpen] = useState(false);
  const [who, setWho] = useState({ status: 'loading', senders: [] });
  const loadViewSenders = useViewStore(state => state.loadViewSenders);
  const addSendersToView = useViewStore(state => state.addSendersToView);
  const blockSendersInView = useViewStore(state => state.blockSendersInView);
  const removeSendersFromView = useViewStore(state => state.removeSendersFromView);
  const keepMessageOutOfView = useViewStore(state => state.keepMessageOutOfView);
  const [targetId, setTargetId] = useState(null);
  const [mailboxOnly, setMailboxOnly] = useState(false);
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);

  const request = useRef(0);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  // ── The hovercard: one card, one timer pair, for every chip. ──
  const cardId = useId();
  const [hover, setHover] = useState(null);
  const hoverRef = useRef(null);
  hoverRef.current = hover;
  const openTimer = useRef(null);
  const closeTimer = useRef(null);
  const pointerFocus = useRef(false);
  const clearTimers = () => { clearTimeout(openTimer.current); clearTimeout(closeTimer.current); };
  useEffect(() => clearTimers, []);

  const hoverIn = (term, el) => {
    clearTimers();
    if (hoverRef.current?.term === term) return;
    openTimer.current = setTimeout(() => setHover({ term, el }), OPEN_DELAY);
  };
  const hoverOut = () => {
    clearTimers();
    closeTimer.current = setTimeout(() => setHover(null), CLOSE_GRACE);
  };
  const focusIn = (term, el) => {
    // A click focuses the chip too; the pointer already has its own delay.
    if (pointerFocus.current) { pointerFocus.current = false; return; }
    clearTimers();
    setHover({ term, el });
  };
  const closeCard = useCallback(() => { clearTimers(); setHover(null); }, []);

  const readAttachmentsRef = useRef(readAttachments);
  readAttachmentsRef.current = readAttachments;
  const emailRef = useRef(email);
  emailRef.current = email;
  // The email's own stamp first, the props only for a row that carries none:
  // the same order for the identity and for the view made from it.
  const whereAccount = email?._accountId ?? accountId ?? null;
  const whereMailbox = email?._mailbox ?? mailbox ?? null;
  const identity = [whereAccount ?? '', whereMailbox ?? '', email?.uid ?? '', email?.messageId ?? ''].join('\u0000');

  useEffect(() => {
    const ticket = ++request.current;
    setLoad({ status: 'loading', keywords: [] });
    setSelected(new Set());
    setPickedSenders(new Set());
    setArmed(false);
    setNotice(null);
    setBusy(false);
    closeCard();
    setReadingAttachments(false);
    const live = () => ticket === request.current && alive.current;
    const show = reply => {
      const keywords = Array.isArray(reply?.keywords) ? reply.keywords.filter(k => k?.term) : [];
      if (!reply?.available) setLoad({ status: 'unavailable', keywords: [] });
      else setLoad({ status: keywords.length ? 'ready' : 'empty', keywords });
      return !!reply?.available;
    };
    Promise.resolve()
      .then(() => loadKeywords(emailRef.current))
      .then(
        reply => {
          if (!live()) return;
          if (!show(reply) || !readAttachmentsRef.current) return;
          // Then the attachments: a failure here leaves the first answer.
          setReadingAttachments(true);
          return Promise.resolve()
            .then(() => loadKeywords(emailRef.current, { withAttachments: true }))
            .then(more => { if (live() && more?.available) show(more); }, () => {})
            .then(() => { if (live()) setReadingAttachments(false); });
        },
        () => {
          if (live()) setLoad({ status: 'error', keywords: [] });
        },
      );
    return () => { request.current += 1; };
  }, [identity, loadKeywords, closeCard]);

  // A daemon that sends no kind is the words-only answer it used to be.
  const rows = KINDS
    .map(({ kind, labelKey }) => ({ kind, labelKey, items: load.keywords.filter(k => (k.kind || 'word') === kind) }))
    .filter(row => row.items.length);
  const terms = load.keywords.map(k => k.term).filter(term => selected.has(term));
  const target = views.find(view => view.id === targetId) || views[0] || null;
  const fromAddress = typeof email?.from === 'string'
    ? (email.from.match(/<([^>]+)>/)?.[1] || email.from)
    : email?.from?.address;
  const choices = senderChoices(fromAddress);
  const sendersPicked = choices.filter(choice => pickedSenders.has(choice));
  const targetDef = target?.def;
  const targetDefKey = JSON.stringify(targetDef || null);

  // Who sends what the chosen view finds, read when asked for and again when
  // the view's rules change under it (an allow or a block saved from the list).
  const whoRequest = useRef(0);
  useEffect(() => {
    if (!whoOpen || !targetDef) return undefined;
    const ticket = ++whoRequest.current;
    setWho(prev => ({ status: prev.senders.length ? 'ready' : 'loading', senders: prev.senders }));
    Promise.resolve()
      .then(() => loadViewSenders(targetDef))
      .then(
        reply => {
          if (ticket !== whoRequest.current || !alive.current) return;
          if (!reply?.available) setWho({ status: 'unavailable', senders: [] });
          else setWho({ status: 'ready', senders: Array.isArray(reply.senders) ? reply.senders : [] });
        },
        () => { if (ticket === whoRequest.current && alive.current) setWho({ status: 'unavailable', senders: [] }); },
      );
    return () => { whoRequest.current += 1; };
    // The key, not the object: a views reload hands over equal definitions.
  }, [whoOpen, target?.id, targetDefKey, loadViewSenders]);
  const options = useMemo(() => views.map(view => ({ value: view.id, label: viewLabel(view, t) })), [views, t]);

  const toggle = (term) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(term)) next.delete(term); else next.add(term);
      return next;
    });
    setArmed(false);
    setNotice(null);
  };

  const toggleSender = (value) => {
    setPickedSenders(prev => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value); else next.add(value);
      return next;
    });
    setArmed(false);
    setNotice(null);
  };

  // A save answered after the email changed belongs to the email it was made
  // on: no confirmation on, and no clearing of, the one open now.
  const done = (ticket, kind) => {
    if (!alive.current || ticket !== request.current) return;
    setNotice(kind);
    if (kind === 'added' || kind === 'created') { setSelected(new Set()); setPickedSenders(new Set()); }
  };

  const addToView = async (confirmed = false) => {
    if ((!terms.length && !sendersPicked.length) || !target || busy) return;
    // Words added to a view that searches for none narrow it to those words.
    if (!confirmed && terms.length && viewQueryIsEmpty(target)) { setArmed(true); setNotice(null); return; }
    const ticket = request.current;
    setArmed(false);
    setBusy(true);
    try {
      let ok = true;
      if (terms.length) ok = !!(await addTermsToView(target.id, terms))?.ok;
      if (ok && sendersPicked.length) ok = !!(await addSendersToView(target.id, sendersPicked))?.ok;
      done(ticket, ok ? 'added' : 'saveFailed');
    } catch {
      done(ticket, 'saveFailed');
    } finally {
      if (alive.current && ticket === request.current) setBusy(false);
    }
  };

  /// One save against the chosen view that does not clear the picks: the
  /// "keep out" buttons and the sender list's rows.
  const ruleChange = async (kind, save) => {
    if (!target || busy) return;
    const ticket = request.current;
    setBusy(true);
    try {
      const reply = await save();
      done(ticket, reply?.ok ? kind : 'saveFailed');
    } catch {
      done(ticket, 'saveFailed');
    } finally {
      if (alive.current && ticket === request.current) setBusy(false);
    }
  };

  const createView = async () => {
    if ((!terms.length && !sendersPicked.length) || busy) return;
    const ticket = request.current;
    setArmed(false);
    setBusy(true);
    try {
      const where = {
        accountId: whereAccount,
        mailbox: mailboxOnly && whereMailbox ? whereMailbox : null,
        ...(sendersPicked.length ? { senders: sendersPicked } : {}),
      };
      const reply = await createViewFromTerms(terms, where, premium);
      if (reply?.ok) done(ticket, 'created');
      else done(ticket, reply?.reason === 'limit' ? 'limit' : 'saveFailed');
    } catch {
      done(ticket, 'saveFailed');
    } finally {
      if (alive.current && ticket === request.current) setBusy(false);
    }
  };

  const STATE_KEYS = { loading: 'viewBuilder.loading', unavailable: 'viewBuilder.unavailable', empty: 'viewBuilder.empty', error: 'viewBuilder.error' };
  const nothingPicked = terms.length === 0 && sendersPicked.length === 0;
  const mine = who.senders.find(sender => sender.own && senderState(targetDef, sender.address) !== 'blocked');

  return (
    <motion.div
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: 'auto', opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={{ duration: 0.2, ease: 'easeInOut' }}
      className="overflow-hidden"
    >
      <div data-testid="view-builder-panel" className="mx-4 mb-2 px-3 py-2.5 rounded-lg border border-mail-border"
        style={{ backgroundColor: 'color-mix(in srgb, var(--mail-surface) 60%, transparent)' }}>
        <div className="flex items-center justify-between gap-2 mb-2">
          <h3 className="text-xs font-medium text-mail-text-muted">{t('viewBuilder.title')}</h3>
          <Button variant="ghost" size="xs" icon aria-label={t('common.close')} title={t('common.close')} onClick={onClose}>
            <X size={13} aria-hidden="true" />
          </Button>
        </div>

        {load.status !== 'ready' && (
          <p data-testid="view-builder-state" className="text-xs text-mail-text-muted">{t(load.status === 'empty' && readingAttachments ? 'viewBuilder.readingAttachments' : STATE_KEYS[load.status])}</p>
        )}
        {(load.status === 'ready' || load.status === 'empty') && (
          <>
            {load.status === 'ready' && <div data-testid="view-builder-chips" role="group" aria-label={t('viewBuilder.title')} className="flex flex-col gap-2">
              {rows.map(({ kind, labelKey, items }) => (
                <div key={kind} data-testid={`view-builder-row-${kind}`} className="flex flex-col gap-1">
                  {rows.length > 1 && (
                    <h4 className="text-[11px] font-medium uppercase tracking-wide text-mail-text-muted">{t(labelKey)}</h4>
                  )}
                  <div className="flex flex-wrap gap-1.5">
                    {items.map(({ term, source }) => {
                      const checked = selected.has(term);
                      return (
                        <KeywordChip
                          key={term}
                          term={term}
                          checked={checked}
                          fromAttachment={source === 'attachment'}
                          attachmentLabel={t('viewBuilder.fromAttachment')}
                          describedBy={hover?.term === term ? cardId : undefined}
                          // A click that focused nothing (an already focused chip,
                          // or WebKit, which never focuses a clicked button) must
                          // not leave the flag to swallow the next Tab.
                          onClick={() => { pointerFocus.current = false; toggle(term); }}
                          onPointerDown={() => { pointerFocus.current = true; }}
                          onPointerEnter={e => hoverIn(term, e.currentTarget)}
                          onPointerLeave={() => { pointerFocus.current = false; hoverOut(); }}
                          onFocus={e => focusIn(term, e.currentTarget)}
                          onBlur={() => { pointerFocus.current = false; hoverOut(); }}
                        />
                      );
                    })}
                  </div>
                </div>
              ))}
              {readingAttachments && (
                <p data-testid="view-builder-reading-attachments" className="text-xs text-mail-text-muted">
                  {t('viewBuilder.readingAttachments')}
                </p>
              )}
            </div>}

            {choices.length > 0 && (
              <div data-testid="view-builder-senders" role="group" aria-label={t('viewBuilder.senders')} className="mt-2 flex flex-col gap-1">
                <h4 className="text-[11px] font-medium uppercase tracking-wide text-mail-text-muted">{t('viewBuilder.senders')}</h4>
                <div className="flex flex-wrap gap-1.5">
                  {choices.map((choice, index) => (
                    <SenderChip key={choice} value={choice} address={fromAddress} index={index} checked={pickedSenders.has(choice)} onClick={() => toggleSender(choice)} />
                  ))}
                </div>
              </div>
            )}

            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              {views.length > 0 && <>
                <Combobox
                  value={target?.id}
                  options={options}
                  onChange={(id) => { setTargetId(id); setArmed(false); }}
                  ariaLabel={t('viewBuilder.addTo')}
                  testId="view-builder-target"
                  className="min-w-0 max-w-[200px] text-xs"
                />
                <Button size="xs" variant="secondary" data-testid="view-builder-add"
                  disabled={nothingPicked || !target || busy} onClick={() => addToView(false)}>
                  {t('viewBuilder.addTo')}
                </Button>
              </>}
              <Button size="xs" variant="accentTint" data-testid="view-builder-new"
                disabled={nothingPicked || busy} onClick={createView}>
                {t('viewBuilder.newView')}
              </Button>
              {whereMailbox && (
                <label className="inline-flex items-center gap-1.5 text-xs text-mail-text-muted cursor-pointer">
                  <input type="checkbox" className="custom-checkbox" data-testid="view-builder-this-mailbox"
                    checked={mailboxOnly} onChange={e => setMailboxOnly(e.target.checked)} />
                  {t('viewBuilder.thisMailboxOnly')}
                </label>
              )}
            </div>

            {target && (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Button size="xs" variant="ghost" data-testid="view-builder-keep-out" disabled={busy}
                  onClick={() => ruleChange('keptOut', () => keepMessageOutOfView(target.id, email))}>
                  {t('viewBuilder.keepOut', { view: viewLabel(target, t) })}
                </Button>
                {choices[0] && (
                  <Button size="xs" variant="ghost" data-testid="view-builder-block-sender" disabled={busy}
                    onClick={() => ruleChange('blocked', () => blockSendersInView(target.id, [choices[0]]))}>
                    {t('viewBuilder.blockSender', { view: viewLabel(target, t) })}
                  </Button>
                )}
                <Button size="xs" variant="ghost" data-testid="view-builder-show-senders" aria-expanded={whoOpen}
                  onClick={() => setWhoOpen(open => !open)}>
                  {t(whoOpen ? 'viewBuilder.hideSenders' : 'viewBuilder.showSenders')}
                </Button>
              </div>
            )}

            {target && whoOpen && (
              <div data-testid="view-builder-who" className="mt-2 flex flex-col gap-1">
                {who.status !== 'ready' ? (
                  <p data-testid="view-builder-who-state" className="text-xs text-mail-text-muted">
                    {t(who.status === 'loading' ? 'viewBuilder.loading' : 'viewBuilder.sendersUnavailable')}
                  </p>
                ) : <>
                  {mine && (
                    <Button size="xs" variant="accentTint" data-testid="view-builder-hide-mine" disabled={busy} className="self-start"
                      onClick={() => ruleChange('blocked', () => blockSendersInView(target.id, [mine.address]))}>
                      {t('viewBuilder.hideMine')}
                    </Button>
                  )}
                  <ul className="flex flex-col divide-y divide-mail-border">
                    {who.senders.map((sender, index) => {
                      const state = senderState(targetDef, sender.address);
                      return (
                        <li key={sender.address} data-testid={`view-builder-who-${index}`} className="flex items-center gap-2 py-1 text-xs">
                          <span className="min-w-0 flex-1 truncate text-mail-text">
                            <PrivateAddress value={sender.name || sender.address} />
                            {sender.name && <span className="ml-1 text-mail-text-muted"><PrivateAddress value={sender.address} /></span>}
                          </span>
                          {sender.own && <span className="text-mail-text-muted">{t('viewBuilder.you')}</span>}
                          <span className="tabular-nums text-mail-text-muted">{sender.count}</span>
                          <span className={state === 'allowed' ? 'text-mail-success' : state === 'open' ? 'text-mail-text-muted' : 'text-mail-warning'}>
                            {t(state === 'open' ? 'common.open' : `viewBuilder.state.${state}`)}
                          </span>
                          {state !== 'allowed' && (
                            <Button size="xs" variant="ghost" data-testid={`view-builder-who-${index}-allow`} disabled={busy}
                              onClick={() => ruleChange('added', () => addSendersToView(target.id, [sender.address]))}>{t('viewBuilder.allow')}</Button>
                          )}
                          {state !== 'blocked' && (
                            <Button size="xs" variant="ghost" data-testid={`view-builder-who-${index}-block`} disabled={busy}
                              onClick={() => ruleChange('blocked', () => blockSendersInView(target.id, [sender.address]))}>{t('viewBuilder.block')}</Button>
                          )}
                          {(state === 'allowed' || state === 'blocked') && (
                            <Button size="xs" variant="ghost" data-testid={`view-builder-who-${index}-clear`} disabled={busy}
                              onClick={() => ruleChange('added', () => removeSendersFromView(target.id, [sender.address]))}>{t('common.clear')}</Button>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </>}
              </div>
            )}

            {armed && (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <p data-testid="view-builder-empty-warning" role="alert" className="text-xs text-mail-warning">
                  {t('viewBuilder.emptyQueryWarning')}
                </p>
                <Button size="xs" variant="secondary" data-testid="view-builder-confirm" disabled={busy} onClick={() => addToView(true)}>
                  {t('viewBuilder.confirm')}
                </Button>
              </div>
            )}

            {notice && (
              <p role="status" data-testid={notice === 'limit' ? 'view-builder-refused' : 'view-builder-notice'}
                className={`mt-2 text-xs ${GOOD_NOTICES.includes(notice) ? 'text-mail-success' : 'text-mail-text-muted'}`}>
                {notice === 'limit' ? t('views.limitReached', { max: MAX_FREE_VIEWS }) : t(NOTICE_KEYS[notice])}
              </p>
            )}
          </>
        )}
      </div>
      <KeywordHovercard
        id={cardId}
        term={hover?.term || null}
        anchorEl={hover?.el || null}
        open={!!hover}
        onEnter={() => clearTimeout(closeTimer.current)}
        onLeave={hoverOut}
        onClose={closeCard}
      />
    </motion.div>
  );
}
