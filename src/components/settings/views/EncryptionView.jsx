// Settings > Privacy & security > Encryption as a view: the OpenPGP secret keys the app decrypts
// mail with, listed, imported (pasted, or from a file) and removed. Decrypt only.
//
// `keys`: `[{ fingerprint, userIds, created }]`; `armored`/`onArmored` and `passphrase`/
// `onPassphrase`: the form; `onImport()` imports the pasted key, `onChooseFile()` a key file (the
// app picks it: desktop through a hidden file input, `fileInput`, the phone through the system
// picker); `onRemove(fingerprint)`; `busy` while a call runs; `error`: its message.
import React from 'react';
import { KeyRound, Trash2 } from 'lucide-react';
import { SettingRow } from '../../ui/SettingRow';
import { Button } from '../../ui/Button';
import { SettingsPageLayout } from '../../ui/SettingsForm';
import { useT, useViewEnv } from './viewContext';

// `ABCD1234...` in groups of four, the way every OpenPGP tool prints it.
export const groupedFingerprint = fp => (fp || '').match(/.{1,4}/g)?.join(' ') || '';

export function EncryptionView({ keys, armored, onArmored, passphrase, onPassphrase, busy, error, onImport, onRemove, onChooseFile, fileInput = null }) {
  const t = useT();
  const { locale } = useViewEnv();
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
                    {(key.userIds || []).map(id => <div key={id} className="text-sm text-mail-text break-words">{id}</div>)}
                    <div className="font-mono text-xs text-mail-text-muted break-all">{groupedFingerprint(key.fingerprint)}</div>
                    <div className="text-xs text-mail-text-muted">
                      {t('pgp.created', { date: new Date(key.created * 1000).toLocaleDateString(locale) })}
                    </div>
                  </div>
                  <Button variant="ghost" size="sm" icon aria-label={t('pgp.removeKey')} disabled={busy}
                    onClick={() => onRemove(key.fingerprint)}>
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
            onChange={e => onArmored(e.target.value)}
            placeholder={t('pgp.keyPlaceholder')}
            rows={5}
            spellCheck={false}
            className="settings-input font-mono text-xs"
          />
        </SettingRow>
        <div>
          {fileInput}
          <Button variant="secondary" size="sm" onClick={onChooseFile}>{t('pgp.chooseFile')}</Button>
        </div>
        <SettingRow label={t('pgp.passphraseLabel')} description={t('pgp.passphraseHelp')}>
          <input
            type="password"
            value={passphrase}
            onChange={e => onPassphrase(e.target.value)}
            autoComplete="off"
            className="settings-input"
          />
        </SettingRow>
        <div className="flex items-center gap-3">
          <Button variant="primary" size="sm" onClick={onImport} disabled={busy || !armored.trim()} loading={busy}>
            {t('pgp.import')}
          </Button>
        </div>
        {error && <p className="text-xs text-mail-danger" role="alert">{error}</p>}
        <p className="text-xs text-mail-text-muted">{t('pgp.decryptOnly')}</p>
      </section>
    </SettingsPageLayout>
  );
}
