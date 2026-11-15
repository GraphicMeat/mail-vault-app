// Settings > Privacy & security > Encryption: the OpenPGP secret keys the engine decrypts mail
// with, as desktop's Encryption page (src/components/settings/EncryptionSettings.jsx) keeps them.
// The keys live in the phone's secret store behind the engine's `mobile.pgp.*`; this page only
// lists, imports and removes them. A pasted key goes to the engine once, on Import, and the field
// is cleared. A key file goes through the system picker: the page gets only its handle, hands it
// straight to the engine with the passphrase typed above, and the engine reads and deletes the
// copy. The viewer decrypts on open (`mobile.message.body`'s `pgp`). Decrypt only, as on desktop.
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { daemonCall, pickFiles } from './transport.js';
import { useT, getMobileLocale } from './i18n.js';

// `ABCD1234...` in groups of four, the way every OpenPGP tool prints it.
const grouped = (fp) => (fp || '').match(/.{1,4}/g)?.join(' ') || '';

export default function EncryptionSettings() {
  const t = useT();
  const id = useId();
  const [keys, setKeys] = useState([]);
  const [armored, setArmored] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  // `call` names its method literally, so the seam scan (seam.js) can follow it.
  const run = useCallback(async (call) => {
    setBusy(true);
    setError(null);
    try {
      const reply = await call();
      if (mounted.current) setKeys(reply?.keys || []);
      return true;
    } catch (e) {
      if (mounted.current) setError(t('pgp.failed', { err: e?.message || String(e) }));
      return false;
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [t]);

  useEffect(() => { run(() => daemonCall('mobile.pgp.listKeys', {})); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const importPasted = async () => {
    if (await run(() => daemonCall('mobile.pgp.importKey', { armored, passphrase })) && mounted.current) {
      setArmored('');
      setPassphrase('');
    }
  };

  const importFile = async () => {
    let picked;
    try {
      picked = await pickFiles('files');
    } catch (e) {
      setError(t('pgp.failed', { err: e?.message || String(e) }));
      return;
    }
    const file = picked.find((f) => f.handle);
    if (!file) return;
    if (await run(() => daemonCall('mobile.pgp.importKey', { handle: file.handle, passphrase })) && mounted.current) setPassphrase('');
  };

  return (
    <>
      <p className="mv-settings__note">{t('pgp.intro')}</p>
      <h2 className="mv-settings__heading">{t('pgp.yourKeys')}</h2>
      <ul className="mv-settings__list" data-mv-pgp-keys>
        {keys.length === 0 && <li className="mv-setting__hint mv-templates__empty" data-mv-pgp-none>{t('pgp.noKeys')}</li>}
        {keys.map((key) => (
          <li key={key.fingerprint} className="mv-setting mv-templates__row" data-mv-pgp-key>
            <span className="mv-setting__text">
              {(key.userIds || []).map((u) => <span key={u} className="mv-setting__label" dir="auto">{u}</span>)}
              <span className="mv-setting__hint mv-pgp__fp">{grouped(key.fingerprint)}</span>
              <span className="mv-setting__hint">
                {t('pgp.created', { date: new Date(key.created * 1000).toLocaleDateString(getMobileLocale()) })}
              </span>
            </span>
            <button
              type="button"
              className="mv-textbtn mv-textbtn--danger"
              disabled={busy}
              aria-label={`${t('pgp.removeKey')}: ${grouped(key.fingerprint)}`}
              onClick={() => run(() => daemonCall('mobile.pgp.removeKey', { fingerprint: key.fingerprint }))}
            >
              {t('common.delete')}
            </button>
          </li>
        ))}
      </ul>

      <div className="mv-settings__list">
        <div className="mv-acct-edit">
          <div className="mv-acct-edit__field">
            <label className="mv-setting__label" htmlFor={`${id}-pass`}>{t('pgp.passphraseLabel')}</label>
            <input id={`${id}-pass`} className="mv-setting__input" type="password" autoComplete="off" value={passphrase}
              aria-describedby={`${id}-pass-h`} onChange={(e) => setPassphrase(e.target.value)} />
            <span className="mv-setting__hint" id={`${id}-pass-h`}>{t('pgp.passphraseHelp')}</span>
          </div>
          <label className="mv-acct-edit__field" htmlFor={`${id}-key`}>
            <span className="mv-setting__label">{t('pgp.keyLabel')}</span>
            <textarea id={`${id}-key`} className="mv-setting__input mv-acct-edit__sig mv-pgp__key" rows={5} spellCheck={false}
              autoCapitalize="off" autoCorrect="off" value={armored} placeholder={t('pgp.keyPlaceholder')}
              onChange={(e) => setArmored(e.target.value)} />
          </label>
          <div className="mv-acct__actions">
            <button type="button" className="mv-textbtn" data-mv-pgp-file disabled={busy} onClick={importFile}>{t('pgp.chooseFile')}</button>
            <button type="button" className="mv-textbtn" data-mv-pgp-import disabled={busy || !armored.trim()} onClick={importPasted}>{t('pgp.import')}</button>
          </div>
        </div>
      </div>
      {error && <p className="mv-settings__note mv-settings__note--error" role="alert">{error}</p>}
      <p className="mv-settings__note">{t('pgp.decryptOnly')}</p>
    </>
  );
}
