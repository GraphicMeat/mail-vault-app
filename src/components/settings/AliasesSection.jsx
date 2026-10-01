import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { AtSign, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { Button } from '../ui/Button';
import { useSettingsStore } from '../../stores/settingsStore';
import { refreshAliases } from '../../services/aliasDiscovery';
import { SendAsVerifyModal } from './SendAsVerifyModal';
import { SignatureImageSize } from './SignatureImageSize';
import { SignatureEditor } from './SignatureEditor';
import { textToHtml, htmlToText } from '../RichTextEditor';
import { signatureHasContent } from '../../utils/signatureImages';
import { useT } from '../../i18n/index.js';
import { Private } from '../privacy/Private';
import { usePrivateAttr } from '../../hooks/usePrivacy';

// Settings > Accounts > Aliases: every address one account sends from. The
// login comes first and always stays; the aliases after it are the settings
// store's list (services/aliasDiscovery.js fills it from the provider and
// from the account's own mail, the user adds the rest). The radio column is
// the default From (`sendAsAddresses`, '' = the login); compose can still
// pick any of them per message. An alias signs with the account's signature
// unless it holds one of its own (`alias.signature`, see AliasSignature).

const NO_ALIASES = [];
const SOURCE_KEYS = {
  provider: 'settings.accounts.aliases.source.provider',
  detected: 'settings.accounts.aliases.source.detected',
  manual: 'settings.accounts.aliases.source.manual',
};
const STATUS_KEYS = {
  ok: 'settings.accounts.aliases.status.ok',
  unsupported: 'settings.accounts.aliases.status.unsupported',
  denied: 'settings.accounts.aliases.status.denied',
  error: 'settings.accounts.aliases.status.error',
};
const ERROR_KEYS = {
  invalid: 'settings.accounts.aliases.error.invalid',
  login: 'settings.accounts.aliases.error.login',
  duplicate: 'settings.accounts.aliases.error.duplicate',
};
const NAME_SAVE_DELAY_MS = 400;

const key = address => (address || '').trim().toLowerCase();

/** Whether the daemon can ask the provider itself (src-core aliases::is_gmail_oauth). */
function isGoogleSignIn(account) {
  const text = value => (value || '').trim().toLowerCase();
  if (text(account?.authType) !== 'oauth2' || text(account?.oauth2Transport) === 'graph') return false;
  const host = text(account?.imapHost);
  return text(account?.oauth2Provider) === 'google' || host === 'imap.gmail.com' || host === 'imap.googlemail.com';
}

// This session's lookups, kept across the section closing and reopening:
// accountId -> { suggestions, providerStatus }. Suggestions are never stored
// anywhere else; the next session looks again.
const lookups = new Map();
/** Accounts whose automatic lookup this session has started. */
const asked = new Set();
/** Accounts with a lookup running now. */
const pending = new Set();

/** Test seam: forget this session's lookups. */
export function _resetAliasesSection() {
  lookups.clear();
  asked.clear();
  pending.clear();
}

export function AliasesSection({ account, displayName = '' }) {
  const t = useT();
  const pa = usePrivateAttr();
  const accountId = account.id;
  const login = account.email || '';
  const stored = useSettingsStore(s => s.aliases?.[accountId]) || NO_ALIASES;
  const defaultFrom = useSettingsStore(s => s.sendAsAddresses?.[accountId]) || '';
  // A default From saved before aliases existed can have put the login here.
  const aliases = useMemo(
    () => stored.filter(alias => key(alias?.address) && key(alias.address) !== key(login)),
    [stored, login]
  );
  const accountName = displayName || (account.name && key(account.name) !== key(login) ? account.name : '');

  const [lookup, setLookup] = useState(() => lookups.get(accountId) || null);
  const [runningFor, setRunningFor] = useState(null);
  const [verifying, setVerifying] = useState(null);
  const [newAddress, setNewAddress] = useState('');
  const [newName, setNewName] = useState('');
  const [addError, setAddError] = useState(null);
  const addInputRef = useRef(null);
  const accountRef = useRef(account);
  accountRef.current = account;
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const ids = useId();
  const running = runningFor === accountId;

  // refreshAliases never rejects. An answer for an account the user has left
  // is kept for when they come back, and not shown on this one.
  const lookFor = useCallback(() => {
    const target = accountRef.current;
    const id = target.id;
    pending.add(id);
    setRunningFor(id);
    refreshAliases(target).then(result => {
      const answer = { suggestions: result?.suggestions || [], providerStatus: result?.providerStatus || 'error' };
      lookups.set(id, answer);
      pending.delete(id);
      if (!mounted.current || accountRef.current?.id !== id) return;
      setLookup(answer);
      setRunningFor(current => (current === id ? null : current));
    });
  }, []);

  // Opening the section looks once per account per session.
  useEffect(() => {
    setLookup(lookups.get(accountId) || null);
    setRunningFor(pending.has(accountId) ? accountId : null);
    setVerifying(null);
    setNewAddress('');
    setNewName('');
    setAddError(null);
    if (asked.has(accountId)) return;
    asked.add(accountId);
    lookFor();
  }, [accountId, lookFor]);

  const addAlias = event => {
    event.preventDefault();
    const result = useSettingsStore.getState().addAlias(accountId, { address: newAddress, name: newName, source: 'manual' }, login);
    if (!result.ok) {
      setAddError(result.reason);
      addInputRef.current?.focus();
      return;
    }
    setNewAddress('');
    setNewName('');
    setAddError(null);
  };

  const addSuggestion = suggestion => {
    useSettingsStore.getState().addAlias(accountId, { address: suggestion.address, name: suggestion.name || '', source: 'detected' }, login);
  };

  const removeAlias = address => {
    useSettingsStore.getState().removeAlias(accountId, address);
    // The button that had focus is gone with its row.
    addInputRef.current?.focus();
  };

  const setDefault = address => useSettingsStore.getState().setSendAsAddress(accountId, address);

  const listed = new Set([key(login), ...aliases.map(alias => key(alias.address))]);
  const suggestions = (lookup?.suggestions || []).filter(s => key(s?.address) && !listed.has(key(s.address)));
  const loginIsDefault = !key(defaultFrom) || key(defaultFrom) === key(login);
  const status = running ? 'running' : lookup ? lookup.providerStatus : 'idle';
  const statusText = running ? t('settings.accounts.aliases.looking')
    : lookup ? t(STATUS_KEYS[lookup.providerStatus] || STATUS_KEYS.error) : '';
  const radioName = `aliases-default-${ids}`;
  const errorId = `${ids}-add-error`;

  return (
    <div className="settings-section alias-section" data-testid="aliases-section">
      <div className="alias-section-head">
        <div className="min-w-0">
          <h4 className="font-semibold text-mail-text mb-1 flex items-center gap-2">
            <AtSign size={18} className="text-mail-accent-text" />
            {t('settings.accounts.aliases.listTitle')}
          </h4>
          <p data-testid="aliases-provider-hint" className="text-sm text-mail-text-muted">
            {t(isGoogleSignIn(account) ? 'settings.accounts.aliases.hintGmail' : 'settings.accounts.aliases.hintOther')}
          </p>
        </div>
        <Button variant="subtle" size="sm" onClick={lookFor} loading={running} aria-busy={running}
          data-testid="aliases-refresh-btn">
          {!running && <RefreshCw size={14} aria-hidden="true" />}
          {t('settings.accounts.aliases.refresh')}
        </Button>
      </div>

      {/* Always rendered, one line tall, so an answer arriving moves nothing. */}
      <p data-testid="aliases-status" data-status={status} aria-live="polite" className="alias-status">
        {statusText}
      </p>

      <fieldset className="alias-fieldset">
        <legend className="text-sm font-medium text-mail-text">{t('settings.accounts.aliases.defaultAddress')}</legend>
        <p className="text-sm text-mail-text-muted mb-3">{t('settings.accounts.aliases.defaultHint')}</p>
        <ul data-testid="aliases-list" className="alias-list">
          <li data-testid="alias-row" data-address={pa(login, 'email')} data-login="true" className="alias-row">
            <input type="radio" name={radioName} checked={loginIsDefault} onChange={() => setDefault('')}
              aria-label={t('settings.accounts.aliases.useByDefaultFor', { address: pa(login, 'email') })}
              data-testid="alias-default-radio" className="alias-radio" />
            <div className="alias-row-main">
              <div className="alias-row-address">
                <span className="font-mono text-sm text-mail-text break-all"><Private kind="email">{login}</Private></span>
                <span className="alias-badge alias-badge-login">{t('settings.accounts.aliases.badgeLogin')}</span>
              </div>
              {accountName && (
                <p className="text-xs text-mail-text-muted">{t('settings.accounts.aliases.loginName', { name: pa(accountName, 'name') })}</p>
              )}
            </div>
          </li>
          {aliases.map(alias => (
            <AliasRow key={`${accountId}:${key(alias.address)}`} accountId={accountId} alias={alias}
              radioName={radioName} isDefault={key(defaultFrom) === key(alias.address)}
              placeholder={pa(accountName, 'name')} onDefault={() => setDefault(alias.address)}
              onVerify={() => setVerifying(alias)} onRemove={() => removeAlias(alias.address)} />
          ))}
        </ul>
        {!aliases.length && (
          <p data-testid="aliases-empty" className="text-sm text-mail-text-muted mt-3">{t('settings.accounts.aliases.empty')}</p>
        )}
      </fieldset>

      <form data-testid="alias-add-form" onSubmit={addAlias} noValidate className="alias-add">
        <div className="alias-add-fields">
          <div className="alias-add-address">
            <label htmlFor={`${ids}-add`} className="block text-sm font-medium text-mail-text mb-2">{t('settings.accounts.aliases.addAddress')}</label>
            <input id={`${ids}-add`} ref={addInputRef} type="email" autoComplete="off" spellCheck={false}
              value={newAddress}
              onChange={event => { setNewAddress(event.target.value); setAddError(null); }}
              placeholder={t('settings.accounts.aliases.addPlaceholder')}
              aria-invalid={addError ? 'true' : undefined}
              aria-describedby={addError ? errorId : undefined}
              data-testid="alias-add-input"
              className="w-full px-4 py-2.5 bg-mail-bg border border-mail-border rounded-lg text-mail-text placeholder-mail-text-muted focus:border-mail-accent transition-all" />
          </div>
          <div className="alias-add-name">
            <label htmlFor={`${ids}-add-name`} className="block text-sm font-medium text-mail-text mb-2">{t('settings.accounts.aliases.addName')}</label>
            <input id={`${ids}-add-name`} type="text" autoComplete="off"
              value={newName} onChange={event => setNewName(event.target.value)}
              placeholder={pa(accountName, 'name')}
              data-testid="alias-add-name-input"
              className="w-full px-4 py-2.5 bg-mail-bg border border-mail-border rounded-lg text-mail-text placeholder-mail-text-muted focus:border-mail-accent transition-all" />
          </div>
          <Button type="submit" variant="primary" size="lg" disabled={!newAddress.trim()} data-testid="alias-add-btn">
            <Plus size={16} aria-hidden="true" />
            {t('settings.accounts.aliases.add')}
          </Button>
        </div>
        {addError && (
          <p id={errorId} data-testid="alias-add-error" className="text-sm text-mail-danger mt-2">
            {t(ERROR_KEYS[addError] || ERROR_KEYS.invalid)}
          </p>
        )}
      </form>

      {!!suggestions.length && (
        <div data-testid="aliases-suggestions" className="alias-suggestions">
          <p className="text-sm text-mail-text">{t('settings.accounts.aliases.suggestionsTitle')}</p>
          <div className="flex items-center gap-2 flex-wrap mt-2">
            {suggestions.map(suggestion => (
              <button key={key(suggestion.address)} type="button" onClick={() => addSuggestion(suggestion)}
                data-testid="alias-suggestion-add" data-address={pa(suggestion.address, 'email')}
                aria-label={t('settings.accounts.aliases.addSuggestion', { address: pa(suggestion.address, 'email') })}
                className="alias-chip">
                <Plus size={12} aria-hidden="true" />
                <span className="font-mono"><Private kind="email">{suggestion.address}</Private></span>
              </button>
            ))}
          </div>
        </div>
      )}

      {verifying && (
        <SendAsVerifyModal
          isOpen
          account={account}
          sendAsAddress={verifying.address}
          displayName={verifying.name || accountName}
          onClose={() => setVerifying(null)}
        />
      )}
    </div>
  );
}

/** One alias: the default radio, its address and source, its name, Verify and Remove. */
function AliasRow({ accountId, alias, radioName, isDefault, placeholder, onDefault, onVerify, onRemove }) {
  const t = useT();
  const pa = usePrivateAttr();
  const nameId = useId();
  return (
    <li data-testid="alias-row" data-address={pa(alias.address, 'email')} className="alias-row">
      <input type="radio" name={radioName} checked={isDefault} onChange={onDefault}
        aria-label={t('settings.accounts.aliases.useByDefaultFor', { address: pa(alias.address, 'email') })}
        data-testid="alias-default-radio" className="alias-radio" />
      <div className="alias-row-main">
        <div className="alias-row-address">
          <span className="font-mono text-sm text-mail-text break-all"><Private kind="email">{alias.address}</Private></span>
          <span data-testid="alias-source-badge" className="alias-badge">{t(SOURCE_KEYS[alias.source] || SOURCE_KEYS.manual)}</span>
        </div>
        <div className="alias-name">
          <label htmlFor={nameId} className="text-xs text-mail-text-muted">{t('settings.accounts.aliases.nameLabel')}</label>
          <AliasNameField id={nameId} accountId={accountId} alias={alias} placeholder={placeholder} />
        </div>
        <AliasSignature accountId={accountId} alias={alias} />
      </div>
      <div className="alias-row-actions">
        <Button variant="ghost" size="sm" onClick={onVerify} data-testid="alias-verify-btn"
          title={t('settings.accounts.sendTestMessageAddress')}
          aria-label={t('settings.accounts.aliases.verifyFor', { address: alias.address })}>
          {t('settings.accounts.verify')}
        </Button>
        <Button variant="ghost" size="sm" onClick={onRemove} data-testid="alias-remove-btn"
          aria-label={t('settings.accounts.aliases.removeFor', { address: alias.address })}>
          <Trash2 size={14} aria-hidden="true" />
          {t('common.remove')}
        </Button>
      </div>
    </li>
  );
}

/**
 * The name recipients see for one alias. Saved a moment after typing stops,
 * on leaving the field, and when the row goes away with a change pending.
 */
function AliasNameField({ id, accountId, alias, placeholder }) {
  const [value, setValue] = useState(alias.name || '');
  const latest = useRef({ value, saved: alias.name || '' });
  latest.current = { value, saved: alias.name || '' };
  const timer = useRef(null);

  // The store trims what it keeps: a field still showing "Desk " for a
  // saved "Desk" is the same name, and the user may be mid-word.
  useEffect(() => {
    setValue(current => (current.trim() === (alias.name || '') ? current : (alias.name || '')));
  }, [alias.name]);

  const save = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = null;
    const { value: next, saved } = latest.current;
    if (next.trim() !== saved) useSettingsStore.getState().updateAlias(accountId, alias.address, { name: next });
  }, [accountId, alias.address]);

  useEffect(() => () => { if (timer.current) save(); }, [save]);

  return (
    <input id={id} type="text" autoComplete="off" value={value} placeholder={placeholder}
      onChange={event => {
        setValue(event.target.value);
        latest.current = { ...latest.current, value: event.target.value };
        clearTimeout(timer.current);
        timer.current = setTimeout(save, NAME_SAVE_DELAY_MS);
      }}
      onBlur={save}
      data-testid="alias-name-input"
      className="alias-name-input w-full px-3 py-1.5 bg-mail-bg border border-mail-border rounded-lg text-sm text-mail-text placeholder-mail-text-muted focus:border-mail-accent transition-all" />
  );
}

const signatureHtmlOf = signature => signature?.html || textToHtml(signature?.text || '');

/**
 * Which signature mail from one alias carries: the account's, or its own.
 * Own starts as a copy of the account's, since an alias usually differs from
 * it by a line. The editor is only mounted for an alias that has its own, so a
 * long alias list does not run one editor per row.
 */
function AliasSignature({ accountId, alias }) {
  const t = useT();
  const own = !!alias.signature;
  const useOwn = () => {
    const account = useSettingsStore.getState().getSignature(accountId);
    useSettingsStore.getState().updateAlias(accountId, alias.address, { signature: { html: account.html || '', text: account.text || '' } });
  };
  const useAccount = () => useSettingsStore.getState().updateAlias(accountId, alias.address, { signature: null });
  return (
    <div className="alias-signature mt-3" data-testid="alias-signature">
      <div className="account-settings-choice-row">
        <span className="text-xs text-mail-text-muted">{t('settings.accounts.aliases.signatureLabel')}</span>
        <div className="account-settings-choice-group" role="group" aria-label={t('settings.accounts.aliases.signatureFor', { address: alias.address })}>
          <button type="button" aria-pressed={!own} data-testid="alias-signature-account" onClick={useAccount}>
            {t('settings.accounts.aliases.signatureAccount')}
          </button>
          <button type="button" aria-pressed={own} data-testid="alias-signature-own" onClick={useOwn}>
            {t('settings.accounts.aliases.signatureOwn')}
          </button>
        </div>
      </div>
      {own && <AliasSignatureEditor accountId={accountId} alias={alias} />}
    </div>
  );
}

/** The alias's own signature. Saved a moment after typing stops and when the editor goes away. */
function AliasSignatureEditor({ accountId, alias }) {
  const t = useT();
  const [html, setHtml] = useState(() => signatureHtmlOf(alias.signature));
  const latest = useRef(html);
  const timer = useRef(null);

  const save = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = null;
    const store = useSettingsStore.getState();
    // Handed back to the account, or the alias is gone: nothing to write.
    const current = (store.aliases?.[accountId] || []).find(a => key(a?.address) === key(alias.address))?.signature;
    if (!current) return;
    const text = htmlToText(latest.current);
    const kept = signatureHasContent(latest.current, text) ? latest.current : '';
    if (kept === (current.html || '') && text === (current.text || '')) return;
    store.updateAlias(accountId, alias.address, { signature: { html: kept, text } });
  }, [accountId, alias.address]);

  useEffect(() => () => { if (timer.current) save(); }, [save]);

  return (
    <div className="mt-2">
      <SignatureEditor
        html={html}
        heightClass="h-40"
        boxTestId="alias-signature-editor"
        onChange={next => {
          latest.current = next;
          setHtml(next);
          clearTimeout(timer.current);
          timer.current = setTimeout(save, NAME_SAVE_DELAY_MS);
        }}
        placeholder={t('settings.accounts.bestRegardsJohnDoe')}
      />
      <p className="text-xs text-mail-text-muted mt-2">{t('settings.accounts.aliases.signatureOwnHint')}</p>
      <SignatureImageSize html={html} />
    </div>
  );
}
