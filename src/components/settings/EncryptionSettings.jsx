import React, { useEffect, useRef, useState } from 'react';
import { KeyRound, Trash2 } from 'lucide-react';
import { SettingRow } from '../ui/SettingRow';
import { Button } from '../ui/Button';
import { SettingsPageLayout } from '../ui/SettingsForm';
import { pgpListKeys, pgpImportKey, pgpRemoveKey } from '../../services/api';
import { useT, getLocale } from '../../i18n/index.js';

// `ABCD1234...` in groups of four, the way every OpenPGP tool prints it.
const grouped = fp => (fp || '').match(/.{1,4}/g)?.join(' ') || '';

/**
 * Settings > Encryption: the OpenPGP secret keys the daemon decrypts mail
 * with. The keys live in the keychain (the daemon's `pgp.*` RPCs); this page
 * only lists, imports and removes them. A picked key file is read here, in
 * the app: the daemon never opens a user-chosen path.
 */
export function EncryptionSettings() {
  const t = useT();
  const [keys, setKeys] = useState([]);
  const [armored, setArmored] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const fileRef = useRef(null);

  const run = async (call) => {
    setBusy(true);
    setError(null);
    try {
      const reply = await call();
      setKeys(reply?.keys || []);
      return true;
    } catch (e) {
      setError(t('pgp.failed', { err: e?.message || String(e) }));
      return false;
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => { run(pgpListKeys); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const importKey = async () => {
    if (await run(() => pgpImportKey(armored, passphrase))) {
      setArmored('');
      setPassphrase('');
    }
  };

  const pickFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) setArmored(await file.text());
  };

  return (
    <SettingsPageLayout>
      <section className="settings-section space-y-5">
        <h4 className="flex items-center gap-2 font-semibold text-mail-text">
          <KeyRound size={18} className="text-mail-accent-text" />{t('pgp.tab')}
        </h4>
        <p className="text-xs text-mail-text-muted">{t('pgp.intro')}</p>

        <div>
          <div className="text-sm font-medium text-mail-text mb-2">{t('pgp.yourKeys')}</div>
          {keys.length === 0 ? (
            <p className="text-xs text-mail-text-muted" data-testid="pgp-no-keys">{t('pgp.noKeys')}</p>
          ) : (
            <ul className="space-y-2">
              {keys.map(key => (
                <li key={key.fingerprint} data-testid="pgp-key-row"
                  className="flex items-start justify-between gap-3 rounded-lg border border-mail-border bg-mail-surface p-3">
                  <div className="min-w-0">
                    {key.userIds.map(id => <div key={id} className="text-sm text-mail-text break-words">{id}</div>)}
                    <div className="font-mono text-xs text-mail-text-muted break-all">{grouped(key.fingerprint)}</div>
                    <div className="text-xs text-mail-text-muted">
                      {t('pgp.created', { date: new Date(key.created * 1000).toLocaleDateString(getLocale()) })}
                    </div>
                  </div>
                  <Button variant="ghost" size="sm" icon aria-label={t('pgp.removeKey')} disabled={busy}
                    onClick={() => run(() => pgpRemoveKey(key.fingerprint))}>
                    <Trash2 size={16} />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <SettingRow label={t('pgp.keyLabel')}>
          <textarea
            value={armored}
            onChange={e => setArmored(e.target.value)}
            placeholder={t('pgp.keyPlaceholder')}
            rows={5}
            spellCheck={false}
            className="settings-input font-mono text-xs"
          />
        </SettingRow>
        <div>
          <input ref={fileRef} type="file" accept=".asc,.gpg,.key,.pgp,.txt" className="hidden" onChange={pickFile} data-testid="pgp-file-input" />
          <Button variant="secondary" size="sm" onClick={() => fileRef.current?.click()}>{t('pgp.chooseFile')}</Button>
        </div>
        <SettingRow label={t('pgp.passphraseLabel')} description={t('pgp.passphraseHelp')}>
          <input
            type="password"
            value={passphrase}
            onChange={e => setPassphrase(e.target.value)}
            autoComplete="off"
            className="settings-input"
          />
        </SettingRow>
        <div className="flex items-center gap-3">
          <Button variant="primary" size="sm" onClick={importKey} disabled={busy || !armored.trim()} loading={busy}>
            {t('pgp.import')}
          </Button>
        </div>
        {error && <p className="text-xs text-mail-danger" role="alert">{error}</p>}
        <p className="text-xs text-mail-text-muted">{t('pgp.decryptOnly')}</p>
      </section>
    </SettingsPageLayout>
  );
}
