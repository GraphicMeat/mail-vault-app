import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { Check, X } from 'lucide-react';
import { useT } from '../../i18n/index.js';
import { useViewStore, viewLabel, viewQueryIsEmpty, MAX_FREE_VIEWS } from '../../stores/viewStore';
import { useSettingsStore, hasPremiumAccess } from '../../stores/settingsStore';
import { Button } from '../ui/Button';
import { Combobox } from '../ui/Combobox';
import { KeywordHovercard, PrivateWord } from './KeywordHovercard';

/// Hover this long on a chip before its card opens: a pointer crossing the row
/// opens nothing, and asks the daemon nothing.
const OPEN_DELAY = 250;
/// The card survives the pointer's trip from the chip onto it.
const CLOSE_GRACE = 150;

const NOTICE_KEYS = { added: 'viewBuilder.added', created: 'viewBuilder.created', saveFailed: 'viewBuilder.saveFailed' };

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

  const [load, setLoad] = useState({ status: 'loading', keywords: [] });
  const [selected, setSelected] = useState(() => new Set());
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

  const emailRef = useRef(email);
  emailRef.current = email;
  const identity = [email?._accountId ?? accountId ?? '', email?._mailbox ?? mailbox ?? '', email?.uid ?? '', email?.messageId ?? ''].join('\u0000');

  useEffect(() => {
    const ticket = ++request.current;
    setLoad({ status: 'loading', keywords: [] });
    setSelected(new Set());
    setArmed(false);
    setNotice(null);
    closeCard();
    Promise.resolve()
      .then(() => loadKeywords(emailRef.current))
      .then(
        reply => {
          if (ticket !== request.current || !alive.current) return;
          const keywords = Array.isArray(reply?.keywords) ? reply.keywords.filter(k => k?.term) : [];
          if (!reply?.available) setLoad({ status: 'unavailable', keywords: [] });
          else setLoad({ status: keywords.length ? 'ready' : 'empty', keywords });
        },
        () => {
          if (ticket === request.current && alive.current) setLoad({ status: 'error', keywords: [] });
        },
      );
    return () => { request.current += 1; };
  }, [identity, loadKeywords, closeCard]);

  const terms = load.keywords.map(k => k.term).filter(term => selected.has(term));
  const target = views.find(view => view.id === targetId) || views[0] || null;
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

  const done = (kind) => {
    if (!alive.current) return;
    setNotice(kind);
    if (kind === 'added' || kind === 'created') setSelected(new Set());
  };

  const addToView = async (confirmed = false) => {
    if (!terms.length || !target || busy) return;
    // Words added to a view that searches for none narrow it to those words.
    if (!confirmed && viewQueryIsEmpty(target)) { setArmed(true); setNotice(null); return; }
    setArmed(false);
    setBusy(true);
    try {
      const reply = await addTermsToView(target.id, terms);
      done(reply?.ok ? 'added' : 'saveFailed');
    } catch {
      done('saveFailed');
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const createView = async () => {
    if (!terms.length || busy) return;
    setArmed(false);
    setBusy(true);
    try {
      const where = { accountId: accountId ?? email?._accountId ?? null, mailbox: mailboxOnly && mailbox ? mailbox : null };
      const reply = await createViewFromTerms(terms, where, premium);
      if (reply?.ok) done('created');
      else done(reply?.reason === 'limit' ? 'limit' : 'saveFailed');
    } catch {
      done('saveFailed');
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const STATE_KEYS = { loading: 'viewBuilder.loading', unavailable: 'viewBuilder.unavailable', empty: 'viewBuilder.empty', error: 'viewBuilder.error' };
  const nothingPicked = terms.length === 0;

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

        {load.status !== 'ready' ? (
          <p data-testid="view-builder-state" className="text-xs text-mail-text-muted">{t(STATE_KEYS[load.status])}</p>
        ) : (
          <>
            <div data-testid="view-builder-chips" role="group" aria-label={t('viewBuilder.title')} className="flex flex-wrap gap-1.5">
              {load.keywords.map(({ term }) => {
                const checked = selected.has(term);
                return (
                  <button
                    key={term}
                    type="button"
                    role="checkbox"
                    aria-checked={checked}
                    aria-describedby={hover?.term === term ? cardId : undefined}
                    // A click that focused nothing (an already focused chip,
                    // or WebKit, which never focuses a clicked button) must
                    // not leave the flag to swallow the next Tab.
                    onClick={() => { pointerFocus.current = false; toggle(term); }}
                    onPointerDown={() => { pointerFocus.current = true; }}
                    onPointerEnter={e => hoverIn(term, e.currentTarget)}
                    onPointerLeave={() => { pointerFocus.current = false; hoverOut(); }}
                    onFocus={e => focusIn(term, e.currentTarget)}
                    onBlur={() => { pointerFocus.current = false; hoverOut(); }}
                    className={`inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded-full border transition-colors ${checked
                      ? 'border-mail-accent bg-mail-accent/10 text-mail-accent-text'
                      : 'border-mail-border bg-mail-surface text-mail-text hover:bg-mail-surface-hover'}`}
                  >
                    {checked && <Check size={11} aria-hidden="true" />}
                    <PrivateWord word={term} />
                  </button>
                );
              })}
            </div>

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
              {mailbox && (
                <label className="inline-flex items-center gap-1.5 text-xs text-mail-text-muted cursor-pointer">
                  <input type="checkbox" className="custom-checkbox" data-testid="view-builder-this-mailbox"
                    checked={mailboxOnly} onChange={e => setMailboxOnly(e.target.checked)} />
                  {t('viewBuilder.thisMailboxOnly')}
                </label>
              )}
            </div>

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
                className={`mt-2 text-xs ${notice === 'added' || notice === 'created' ? 'text-mail-success' : 'text-mail-text-muted'}`}>
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
