import React, { useMemo, useState, useRef, useEffect } from 'react';
import { useMailStore } from '../stores/mailStore';
import { useAccountStore } from '../stores/accountStore';
import { useSettingsStore, getAccountInitial, getAccountColor } from '../stores/settingsStore';
import { ownAddresses } from '../utils/ownAddresses';
import { withoutRecipients } from '../utils/recipientTokens';
import { Users, Clock, Star } from 'lucide-react';
import { daemonCall } from '../services/daemonClient';
import { formatContact } from '../utils/formatContact';
import { useT } from '../i18n/index.js';
import { Private } from './privacy/Private';
import { usePrivateAttr } from '../hooks/usePrivacy';

const NO_LISTS = { latest: [], popular: [] };
const NO_MATCHES = [];

// The daemon ranks every address seen in mail (`people.contacts.*`); the
// picker only says whose mail to look in and which addresses are the user.
function useContactScope() {
  const accounts = useAccountStore(s => s.accounts);
  const sendAsAddresses = useSettingsStore(s => s.sendAsAddresses);
  const aliases = useSettingsStore(s => s.aliases);
  // Your own aliases are never offered as contacts, like your logins.
  return useMemo(() => ({
    accountIds: (accounts || []).map(a => a.id),
    ownAddresses: (accounts || []).flatMap(account => ownAddresses({ account, sendAsAddress: sendAsAddresses?.[account.id], aliases: aliases?.[account.id] })),
  }), [sendAsAddresses, aliases, accounts]);
}

// The daemon's answer for the current params. A reply to an older request
// (the user typed on) never replaces a newer one; a failure shows nothing.
function useDaemonAnswer(method, params, enabled, empty) {
  const [answer, setAnswer] = useState(empty);
  const key = enabled ? JSON.stringify(params) : '';
  useEffect(() => {
    if (!key) { setAnswer(empty); return undefined; }
    let current = true;
    daemonCall(method, JSON.parse(key)).then(
      r => { if (current) setAnswer(r || empty); },
      () => { if (current) setAnswer(empty); },
    );
    return () => { current = false; };
  }, [method, key, empty]);
  return answer;
}

// Appends a contact address to a comma-separated recipient string. If the
// current value ends mid-token (user was typing), the partial token is
// replaced rather than appended.
function appendRecipient(currentValue, address, hasPartialToken) {
  const formatted = address;
  if (!currentValue) return formatted + ', ';
  if (hasPartialToken) {
    const lastComma = currentValue.lastIndexOf(',');
    const prefix = lastComma >= 0 ? currentValue.slice(0, lastComma + 1) + ' ' : '';
    return prefix + formatted + ', ';
  }
  return currentValue.trimEnd().replace(/,\s*$/, '') + ', ' + formatted + ', ';
}

function getTrailingToken(value) {
  if (!value) return '';
  const lastComma = value.lastIndexOf(',');
  return (lastComma >= 0 ? value.slice(lastComma + 1) : value).trim();
}

// Popover trigger button placed at the end of a recipient field.
// `boostAccountId` is the compose From account; it seeds the filter on open
// and re-syncs when the compose user switches From, so the listing defaults
// to the sender's contacts. Users can still tap "All" or another chip to
// override within the current compose session.
export function ContactsPickerButton({ value, onChange, fieldName, boostAccountId = null, exclude = null }) {
  const t = useT();
  const pa = usePrivateAttr();
  const scope = useContactScope();
  const accounts = useAccountStore(s => s.accounts) || [];
  const accountColors = useSettingsStore(s => s.accountColors);
  const getDisplayName = useSettingsStore(s => s.getDisplayName);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState('latest');
  const popoverRef = useRef(null);

  // Session-local filter. Default = compose From account; re-syncs when the
  // From account changes (e.g. user switches account in the compose header).
  const [filterAccountId, setFilterAccountId] = useState(() => boostAccountId || null);
  useEffect(() => {
    setFilterAccountId(boostAccountId || null);
  }, [boostAccountId]);

  // If the filtered account is removed mid-session, fall back to "All".
  const effectiveFilterId = useMemo(() => {
    if (!filterAccountId) return null;
    return accounts.some(a => a.id === filterAccountId) ? filterAccountId : null;
  }, [filterAccountId, accounts]);

  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const filtered = useDaemonAnswer(
    'people.contacts.top',
    { ...scope, accountId: effectiveFilterId, limit: 50 },
    open,
    NO_LISTS,
  );
  const list = withoutRecipients(tab === 'latest' ? filtered.latest : filtered.popular, exclude);

  const handlePick = (c) => {
    onChange(appendRecipient(value, formatContact(c), false));
  };

  // `fieldName` is the field's caption ("To:"); the sentence wants it bare.
  const pickLabel = t('compose.pickFromContacts', { field: fieldName.replace(/[:：]\s*$/, '') });

  return (
    <div className="relative flex-shrink-0" ref={popoverRef}>
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="p-1.5 text-mail-text-muted hover:text-mail-text hover:bg-mail-surface-hover rounded transition-colors"
        title={pickLabel}
        aria-label={pickLabel}
      >
        <Users size={14} />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 w-80 bg-mail-surface border border-mail-border
                        rounded-lg z-50 overflow-hidden">
          {/* Account filter row: All | <avatar> | <avatar> | ... */}
          {accounts.length > 1 && (
            <div className="flex items-center gap-1 px-2 py-1.5 border-b border-mail-border overflow-x-auto">
              <button
                type="button"
                onClick={() => setFilterAccountId(null)}
                className={`flex-shrink-0 px-2.5 py-1 text-[11px] font-medium rounded-full
                           transition-colors ${effectiveFilterId === null
                             ? 'bg-mail-accent-fill text-white'
                             : 'text-mail-text-muted hover:text-mail-text hover:bg-mail-surface-hover'}`}
                title={t('contacts.allAccounts')}
              >
                {t('contacts.all')}
              </button>
              {accounts.map(a => {
                const active = effectiveFilterId === a.id;
                const initial = getAccountInitial(a, getDisplayName?.(a.id));
                const color = getAccountColor(accountColors, a);
                return (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => setFilterAccountId(a.id)}
                    className={`flex-shrink-0 flex items-center gap-1.5 px-1 py-0.5 rounded-full
                               transition-colors ${active
                                 ? 'bg-mail-surface-hover ring-1 ring-mail-accent'
                                 : 'hover:bg-mail-surface-hover'}`}
                    title={pa(a.email, 'email')}
                  >
                    <span
                      className="w-5 h-5 rounded-full flex items-center justify-center text-white text-[9px] font-bold flex-shrink-0"
                      style={{ backgroundColor: color }}
                    >
                      {initial}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          {/* Sort-mode tabs */}
          <div className="flex border-b border-mail-border">
            <button
              type="button"
              onClick={() => setTab('latest')}
              className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium
                         transition-colors ${tab === 'latest' ? 'text-mail-accent-text border-b-2 border-mail-accent' : 'text-mail-text-muted hover:text-mail-text'}`}
            >
              <Clock size={12} />
              {t('contacts.latest')}
            </button>
            <button
              type="button"
              onClick={() => setTab('popular')}
              className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium
                         transition-colors ${tab === 'popular' ? 'text-mail-accent-text border-b-2 border-mail-accent' : 'text-mail-text-muted hover:text-mail-text'}`}
            >
              <Star size={12} />
              {t('contacts.mostPopular')}
            </button>
          </div>
          <div className="max-h-72 overflow-y-auto">
            {list.length === 0 ? (
              <div className="px-3 py-6 text-center text-xs text-mail-text-muted">
                {t('contacts.noContactsYet')}
              </div>
            ) : (
              list.map(c => (
                <button
                  type="button"
                  key={c.address}
                  onClick={() => handlePick(c)}
                  className="w-full text-left px-3 py-2 hover:bg-mail-surface-hover transition-colors flex items-center gap-2"
                >
                  <div className="w-6 h-6 rounded-full bg-mail-accent/20 flex items-center justify-center flex-shrink-0">
                    <span className="text-[10px] font-semibold text-mail-accent-text">
                      {((c.name || c.address)[0] || '?').toUpperCase()}
                    </span>
                  </div>
                  <div className="flex-1 min-w-0">
                    {c.name && <p className="text-xs font-medium text-mail-text truncate"><Private kind="name">{c.name}</Private></p>}
                    <p className="text-[11px] text-mail-text-muted truncate"><Private kind="email">{c.address}</Private></p>
                  </div>
                  <span className="text-[10px] text-mail-text-muted flex-shrink-0">
                    {tab === 'popular' ? `×${c.count}` : ''}
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// Autocomplete dropdown that follows the input field. Shows prefix matches
// from the full index as the user types. Contacts tied to the currently-
// active account (or the compose From account, via `boostAccountId`) are
// ranked first so the user's primary correspondents surface ahead of cross-
// account hits. `exclude` (the field's chips) are never offered again.
export function ContactsAutocomplete({ value, onChange, inputRef, boostAccountId = null, exclude = null }) {
  const scope = useContactScope();
  const activeAccountId = useMailStore(s => s.activeAccountId);
  const [highlight, setHighlight] = useState(0);
  const [focused, setFocused] = useState(false);

  const effectiveBoost = boostAccountId || activeAccountId;
  const partial = getTrailingToken(value);
  // Contacts already in the field are not offered again: ask for enough extra
  // to still fill the list after they are dropped.
  const found = useDaemonAnswer(
    'people.contacts.search',
    { ...scope, query: partial, boostAccountId: effectiveBoost || null, limit: 6 + (exclude?.length || 0) },
    focused && partial.length >= 1,
    NO_MATCHES,
  );
  const matches = useMemo(
    () => withoutRecipients(found, exclude).slice(0, 6),
    [found, exclude],
  );

  useEffect(() => { setHighlight(0); }, [partial]);

  useEffect(() => {
    if (!inputRef?.current) return;
    const el = inputRef.current;
    const onFocus = () => setFocused(true);
    const onBlur = () => setTimeout(() => setFocused(false), 120);
    el.addEventListener('focus', onFocus);
    el.addEventListener('blur', onBlur);
    return () => {
      el.removeEventListener('focus', onFocus);
      el.removeEventListener('blur', onBlur);
    };
  }, [inputRef]);

  useEffect(() => {
    if (!inputRef?.current) return;
    const el = inputRef.current;
    const onKey = (e) => {
      if (!focused || matches.length === 0) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight(h => Math.min(matches.length - 1, h + 1)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight(h => Math.max(0, h - 1)); }
      else if (e.key === 'Enter' || e.key === 'Tab') {
        const pick = matches[highlight];
        if (pick) {
          e.preventDefault();
          onChange(appendRecipient(value, formatContact(pick), true));
        }
      }
    };
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  }, [inputRef, focused, matches, highlight, value, onChange]);

  if (!focused || matches.length === 0) return null;

  return (
    <div className="absolute left-12 top-full mt-1 w-[min(22rem,calc(100%-3rem))] bg-mail-surface
                    border border-mail-border rounded-lg z-50 overflow-hidden">
      {matches.map((c, i) => (
        <button
          type="button"
          key={c.address}
          onMouseDown={(e) => {
            e.preventDefault();
            onChange(appendRecipient(value, formatContact(c), true));
          }}
          className={`w-full text-left px-3 py-2 flex items-center gap-2 transition-colors
                     ${i === highlight ? 'bg-mail-surface-hover' : 'hover:bg-mail-surface-hover'}`}
        >
          <div className="flex-1 min-w-0">
            {c.name && <p className="text-xs font-medium text-mail-text truncate"><Private kind="name">{c.name}</Private></p>}
            <p className="text-[11px] text-mail-text-muted truncate"><Private kind="email">{c.address}</Private></p>
          </div>
        </button>
      ))}
    </div>
  );
}
