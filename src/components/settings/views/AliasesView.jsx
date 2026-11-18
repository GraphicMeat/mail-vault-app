// Settings > Accounts > Aliases as a view: every address one account sends from. The login comes
// first and always stays; the aliases after it; the radio column is the default From ('' = the
// login), and compose can still pick any of them per message. Then the add form.
//
// - `login`, `accountName` (the name mail goes out with), `aliases` (`[{ address, name, source? }]`),
//   `defaultFrom`; `onDefault(address)`, `onRemove(address)`, `onRename(address, name)` (saved a
//   moment after typing stops, on leaving the field, and when the row goes with a change pending).
// - `onAdd(address, name)` resolves to `{ ok }` or `{ ok: false, reason }` ('invalid', 'login',
//   'duplicate', an `errors.*` key, or null: refused, said elsewhere; the field keeps the address).
// - Desktop's extras, each left out when absent: `hint` (the line under the title), the provider
//   lookup (`onRefresh`, `running`, `status`, `statusText`, `suggestions`, `onAddSuggestion`), the
//   source badge (`showSource`: where each alias came from), `onVerify(alias)`, `renderSignature(alias)` (the
//   alias's own signature), and `dialog` (rendered last: the verify dialog).
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { AtSign, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { Button } from '../../ui/Button';
import { useT, useViewEnv } from './viewContext';

const SOURCE_KEYS = {
  provider: 'settings.accounts.aliases.source.provider',
  detected: 'settings.accounts.aliases.source.detected',
  manual: 'settings.accounts.aliases.source.manual',
};
const ERROR_KEYS = {
  invalid: 'settings.accounts.aliases.error.invalid',
  login: 'settings.accounts.aliases.error.login',
  duplicate: 'settings.accounts.aliases.error.duplicate',
};
const NAME_SAVE_DELAY_MS = 400;

const key = address => (address || '').trim().toLowerCase();

export function AliasesView({
  accountId, login, accountName = '', aliases, defaultFrom = '', onDefault, onAdd, onRemove, onRename,
  hint = null, onRefresh, running = false, status = 'idle', statusText = '', suggestions = [], onAddSuggestion,
  showSource = false, onVerify, renderSignature, dialog = null,
}) {
  const t = useT();
  const { Private, privateAttr: pa, privateInputClass } = useViewEnv();
  const [newAddress, setNewAddress] = useState('');
  const [newName, setNewName] = useState('');
  const [addError, setAddError] = useState(null);
  const addInputRef = useRef(null);
  const accountRef = useRef(accountId);
  accountRef.current = accountId;
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const ids = useId();

  useEffect(() => {
    setNewAddress('');
    setNewName('');
    setAddError(null);
  }, [accountId]);

  // An answer for an account the user has left is not shown on this one.
  const addAlias = async event => {
    event.preventDefault();
    const id = accountId;
    const result = await onAdd(newAddress, newName);
    if (!mounted.current || accountRef.current !== id) return;
    if (!result.ok) {
      setAddError(result.reason);
      addInputRef.current?.focus();
      return;
    }
    setNewAddress('');
    setNewName('');
    setAddError(null);
  };

  const removeAlias = async address => {
    // The button that had focus is gone with its row.
    addInputRef.current?.focus();
    await onRemove(address);
  };

  const loginIsDefault = !key(defaultFrom) || key(defaultFrom) === key(login);
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
          {hint && <p data-testid="aliases-provider-hint" className="text-sm text-mail-text-muted">{hint}</p>}
        </div>
        {onRefresh && (
          <Button variant="subtle" size="sm" onClick={onRefresh} loading={running} aria-busy={running}
            data-testid="aliases-refresh-btn">
            {!running && <RefreshCw size={14} aria-hidden="true" />}
            {t('settings.accounts.aliases.refresh')}
          </Button>
        )}
      </div>

      {/* Always rendered, one line tall, so an answer arriving moves nothing. */}
      {onRefresh && (
        <p data-testid="aliases-status" data-status={status} aria-live="polite" className="alias-status">
          {statusText}
        </p>
      )}

      <fieldset className="alias-fieldset">
        <legend className="text-sm font-medium text-mail-text">{t('settings.accounts.aliases.defaultAddress')}</legend>
        <p className="text-sm text-mail-text-muted mb-3">{t('settings.accounts.aliases.defaultHint')}</p>
        <ul data-testid="aliases-list" className="alias-list">
          <li data-testid="alias-row" data-address={pa(login, 'email')} data-login="true" className="alias-row">
            <input type="radio" name={radioName} checked={loginIsDefault} onChange={() => onDefault('')}
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
            <AliasRow key={`${accountId}:${key(alias.address)}`} alias={alias} showSource={showSource}
              radioName={radioName} isDefault={key(defaultFrom) === key(alias.address)}
              placeholder={pa(accountName, 'name')} onDefault={() => onDefault(alias.address)}
              onRename={name => onRename(alias.address, name)}
              onVerify={onVerify && (() => onVerify(alias))} onRemove={() => removeAlias(alias.address)}
              signature={renderSignature ? renderSignature(alias) : null} />
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
              autoCapitalize="none" inputMode="email"
              value={newAddress}
              onChange={event => { setNewAddress(event.target.value); setAddError(null); }}
              placeholder={t('settings.accounts.aliases.addPlaceholder')}
              aria-invalid={addError ? 'true' : undefined}
              aria-describedby={addError ? errorId : undefined}
              data-testid="alias-add-input"
              className={`${privateInputClass} w-full px-4 py-2.5 bg-mail-bg border border-mail-border rounded-lg text-mail-text placeholder-mail-text-muted focus:border-mail-accent transition-all`} />
          </div>
          <div className="alias-add-name">
            <label htmlFor={`${ids}-add-name`} className="block text-sm font-medium text-mail-text mb-2">{t('settings.accounts.aliases.addName')}</label>
            <input id={`${ids}-add-name`} type="text" autoComplete="off"
              value={newName} onChange={event => setNewName(event.target.value)}
              placeholder={pa(accountName, 'name')}
              data-testid="alias-add-name-input"
              className={`${privateInputClass} w-full px-4 py-2.5 bg-mail-bg border border-mail-border rounded-lg text-mail-text placeholder-mail-text-muted focus:border-mail-accent transition-all`} />
          </div>
          <Button type="submit" variant="primary" size="lg" disabled={!newAddress.trim()} data-testid="alias-add-btn">
            <Plus size={16} aria-hidden="true" />
            {t('settings.accounts.aliases.add')}
          </Button>
        </div>
        {addError && (
          <p id={errorId} data-testid="alias-add-error" className="text-sm text-mail-danger mt-2">
            {t(ERROR_KEYS[addError] || (addError.startsWith('errors.') ? addError : ERROR_KEYS.invalid))}
          </p>
        )}
      </form>

      {!!suggestions.length && (
        <div data-testid="aliases-suggestions" className="alias-suggestions">
          <p className="text-sm text-mail-text">{t('settings.accounts.aliases.suggestionsTitle')}</p>
          <div className="flex items-center gap-2 flex-wrap mt-2">
            {suggestions.map(suggestion => (
              <button key={key(suggestion.address)} type="button" onClick={() => onAddSuggestion(suggestion)}
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

      {dialog}
    </div>
  );
}

/** One alias: the default radio, its address and source, its name, Verify and Remove. */
function AliasRow({ alias, showSource, radioName, isDefault, placeholder, onDefault, onRename, onVerify, onRemove, signature }) {
  const t = useT();
  const { Private, privateAttr: pa } = useViewEnv();
  const nameId = useId();
  return (
    <li data-testid="alias-row" data-address={pa(alias.address, 'email')} className="alias-row">
      <input type="radio" name={radioName} checked={isDefault} onChange={onDefault}
        aria-label={t('settings.accounts.aliases.useByDefaultFor', { address: pa(alias.address, 'email') })}
        data-testid="alias-default-radio" className="alias-radio" />
      <div className="alias-row-main">
        <div className="alias-row-address">
          <span className="font-mono text-sm text-mail-text break-all"><Private kind="email">{alias.address}</Private></span>
          {showSource && (
            <span data-testid="alias-source-badge" className="alias-badge">{t(SOURCE_KEYS[alias.source] || SOURCE_KEYS.manual)}</span>
          )}
        </div>
        <div className="alias-name">
          <label htmlFor={nameId} className="text-xs text-mail-text-muted">{t('settings.accounts.aliases.nameLabel')}</label>
          <AliasNameField id={nameId} alias={alias} placeholder={placeholder} onRename={onRename} />
        </div>
        {signature}
      </div>
      <div className="alias-row-actions">
        {onVerify && (
          <Button variant="ghost" size="sm" onClick={onVerify} data-testid="alias-verify-btn"
            title={t('settings.accounts.sendTestMessageAddress')}
            aria-label={t('settings.accounts.aliases.verifyFor', { address: pa(alias.address, 'email') })}>
            {t('settings.accounts.verify')}
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={onRemove} data-testid="alias-remove-btn"
          aria-label={t('settings.accounts.aliases.removeFor', { address: pa(alias.address, 'email') })}>
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
function AliasNameField({ id, alias, placeholder, onRename }) {
  const { privateInputClass } = useViewEnv();
  const [value, setValue] = useState(alias.name || '');
  const latest = useRef({ value, saved: alias.name || '' });
  latest.current = { value, saved: alias.name || '' };
  const timer = useRef(null);
  const rename = useRef(onRename);
  rename.current = onRename;

  // The store trims what it keeps: a field still showing "Desk " for a
  // saved "Desk" is the same name, and the user may be mid-word.
  useEffect(() => {
    setValue(current => (current.trim() === (alias.name || '') ? current : (alias.name || '')));
  }, [alias.name]);

  const save = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = null;
    const { value: next, saved } = latest.current;
    if (next.trim() !== saved) rename.current(next);
  }, []);

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
      className={`${privateInputClass} alias-name-input w-full px-3 py-1.5 bg-mail-bg border border-mail-border rounded-lg text-sm text-mail-text placeholder-mail-text-muted focus:border-mail-accent transition-all`} />
  );
}
