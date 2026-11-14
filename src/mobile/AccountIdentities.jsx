// An account's aliases and its default From on its own page (AccountEditor.jsx), as desktop's
// "Your addresses" has them: each alias an address and the name recipients see (`aliases`, from a
// desktop import or added here), and the address new messages start from (`sendAs`, '' for the
// login). Compose offers every one of them in its From row. Controlled: the editor's Save writes
// them with the rest. An address that does not read, the login itself and one already listed are
// refused in place, with desktop's words.
import React, { useId, useState } from 'react';
import { useT } from './i18n.js';

const looksLikeEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
const same = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();

export default function AccountIdentities({ email, aliases, sendAs, onChange }) {
  const t = useT();
  const id = useId();
  const [address, setAddress] = useState('');
  const [name, setName] = useState('');
  const [problem, setProblem] = useState(null);

  const add = () => {
    const a = address.trim();
    if (!looksLikeEmail(a)) return setProblem('settings.accounts.aliases.error.invalid');
    if (same(a, email)) return setProblem('settings.accounts.aliases.error.login');
    if (aliases.some((x) => same(x.address, a))) return setProblem('settings.accounts.aliases.error.duplicate');
    setProblem(null);
    setAddress('');
    setName('');
    onChange({ aliases: [...aliases, { address: a, name: name.trim() }], sendAs });
    return undefined;
  };
  const remove = (gone) => onChange({
    aliases: aliases.filter((x) => x !== gone),
    // The default goes back to the login with the alias it named.
    sendAs: same(sendAs, gone.address) ? '' : sendAs,
  });
  const rename = (alias, next) => onChange({ aliases: aliases.map((x) => (x === alias ? { ...x, name: next } : x)), sendAs });

  // The default From: the login, every alias, and an imported `sendAs` that is neither.
  const choices = [['', email], ...aliases.map((a) => [a.address, a.address])];
  if (sendAs && !same(sendAs, email) && !aliases.some((a) => same(a.address, sendAs))) choices.push([sendAs, sendAs]);
  const current = sendAs && !same(sendAs, email) ? (choices.find(([v]) => v && same(v, sendAs))?.[0] ?? '') : '';

  return (
    <div className="mv-acct-edit__group" data-mv-acct-aliases>
      <h3 className="mv-settings__heading">{t('settings.accounts.aliases.listTitle')}</h3>
      {aliases.length === 0 && <p className="mv-setting__hint">{t('settings.accounts.aliases.empty')}</p>}
      <ul className="mv-acct-edit__aliases">
        {aliases.map((a) => (
          <li key={a.address} className="mv-acct-edit__alias">
            <span className="mv-acct-edit__alias-address" dir="auto">{a.address}</span>
            <input
              className="mv-setting__input"
              dir="auto"
              aria-label={`${t('settings.accounts.aliases.nameLabel')}: ${a.address}`}
              placeholder={t('settings.accounts.aliases.addName')}
              maxLength={200}
              value={a.name || ''}
              onChange={(e) => rename(a, e.target.value)}
            />
            <button
              type="button"
              className="mv-textbtn mv-textbtn--danger"
              aria-label={t('settings.accounts.aliases.removeFor', { address: a.address })}
              onClick={() => remove(a)}
            >
              {t('common.remove')}
            </button>
          </li>
        ))}
      </ul>
      <div className="mv-acct-edit__alias-add">
        <input
          className="mv-setting__input"
          type="email"
          inputMode="email"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          aria-label={t('settings.accounts.aliases.addAddress')}
          placeholder={t('settings.accounts.aliases.addPlaceholder')}
          maxLength={320}
          value={address}
          onChange={(e) => { setAddress(e.target.value); setProblem(null); }}
        />
        <input
          className="mv-setting__input"
          dir="auto"
          aria-label={t('settings.accounts.aliases.addName')}
          placeholder={t('settings.accounts.aliases.addName')}
          maxLength={200}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button type="button" className="mv-textbtn" disabled={!address.trim()} onClick={add}>{t('settings.accounts.aliases.add')}</button>
      </div>
      {problem && <p className="mv-settings__note mv-settings__note--error">{t(problem)}</p>}
      <label className="mv-setting mv-setting--choice" htmlFor={`${id}-default`}>
        <span className="mv-setting__text">
          <span className="mv-setting__label">{t('settings.accounts.aliases.defaultAddress')}</span>
        </span>
        <select
          id={`${id}-default`}
          className="mv-setting__select"
          value={current}
          onChange={(e) => onChange({ aliases, sendAs: e.target.value })}
        >
          {choices.map(([v, label]) => <option key={v || 'login'} value={v}>{label}</option>)}
        </select>
      </label>
    </div>
  );
}
