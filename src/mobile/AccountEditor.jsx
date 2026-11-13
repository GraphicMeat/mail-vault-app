// One account's own settings in Settings > Accounts (`mobile.accountSettings.*`): the name mail
// is sent with, the signature compose adds (plain text here; a desktop html signature shows as its
// text and is kept as html until edited), hidden (out of the switcher, the drawer and All Inboxes,
// still listed here to show again). Save writes them in one call and re-reads the accounts. The
// account's own notification switch is carried from the desktop and stored, not shown yet: the
// background run does not read it.
import React, { useEffect, useId, useState } from 'react';
import { daemonCall } from './transport.js';
import { useMobileStore } from './store.js';
import { useT } from './i18n.js';
import { htmlToText } from './prefs.js';

export default function AccountEditor({ account, onDone }) {
  const t = useT();
  const id = useId();
  const [loaded, setLoaded] = useState(null);
  const [name, setName] = useState('');
  const [signature, setSignature] = useState('');
  const [signatureOn, setSignatureOn] = useState(true);
  const [hidden, setHidden] = useState(false);
  const [state, setState] = useState('loading'); // loading | ready | saving | failed

  useEffect(() => {
    let live = true;
    daemonCall('mobile.accountSettings.get', { accountId: account.id }).then(
      (s) => {
        if (!live) return;
        setLoaded(s);
        setName(s.displayName && s.displayName !== account.email ? s.displayName : '');
        setSignature(s.signature ? (s.signature.text || htmlToText(s.signature.html)) : '');
        setSignatureOn(s.signature ? s.signature.enabled !== false : true);
        setHidden(Boolean(s.hidden));
        setState('ready');
      },
      () => { if (live) setState('failed'); },
    );
    return () => { live = false; };
  }, [account.id, account.email]);

  const save = async () => {
    if (!loaded) return;
    setState('saving');
    const values = { displayName: name.trim(), hidden };
    const before = loaded.signature;
    const beforeText = before ? (before.text || htmlToText(before.html)) : '';
    if (signature.trim() !== beforeText.trim() || (before && (before.enabled !== false) !== signatureOn)) {
      // A changed text replaces the html: compose sends plain text.
      values.signature = signature.trim()
        ? { html: signature.trim() === beforeText.trim() && before ? before.html : '', text: signature.trim(), enabled: signatureOn }
        : null;
    }
    try {
      await daemonCall('mobile.accountSettings.set', { accountId: account.id, values });
      await useMobileStore.getState().reloadAccounts();
      onDone();
    } catch {
      setState('failed');
    }
  };

  if (state === 'loading') return <div className="mv-acct-edit" aria-busy="true" />;
  return (
    <div className="mv-acct-edit" data-mv-account-editor>
      <label className="mv-acct-edit__field" htmlFor={`${id}-name`}>
        <span className="mv-setting__label">{t('settings.accounts.displayName')}</span>
        <input id={`${id}-name`} className="mv-setting__input" value={name} placeholder={account.email} maxLength={200} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="mv-acct-edit__field" htmlFor={`${id}-sig`}>
        <span className="mv-setting__label">{t('settings.accounts.aliases.signatureLabel')}</span>
        <textarea id={`${id}-sig`} className="mv-setting__input mv-acct-edit__sig" rows={4} value={signature} onChange={(e) => setSignature(e.target.value)} />
      </label>
      <button type="button" role="switch" aria-checked={signatureOn} className="mv-setting" data-mv-acct="signatureOn" onClick={() => setSignatureOn(!signatureOn)}>
        <span className="mv-setting__text"><span className="mv-setting__label">{t('settings.accounts.automaticallyAddOutgoingEmails')}</span></span>
        <span className="mv-switch" aria-hidden="true"><span className="mv-switch__knob" /></span>
      </button>
      <button type="button" role="switch" aria-checked={hidden} className="mv-setting" data-mv-acct="hidden" onClick={() => setHidden(!hidden)}>
        <span className="mv-setting__text">
          <span className="mv-setting__label">{t('mobile.accounts.hide')}</span>
          <span className="mv-setting__hint">{t('mobile.accounts.hideHint')}</span>
        </span>
        <span className="mv-switch" aria-hidden="true"><span className="mv-switch__knob" /></span>
      </button>
      {state === 'failed' && <p className="mv-settings__note mv-settings__note--error" role="alert">{t('mobile.settings.saveFailed')}</p>}
      <div className="mv-acct__actions">
        <button type="button" className="mv-textbtn" onClick={onDone}>{t('common.cancel')}</button>
        <button type="button" className="mv-textbtn" data-mv-acct-save disabled={state === 'saving' || !loaded} onClick={save}>{t('common.save')}</button>
      </div>
    </div>
  );
}
