import React, { useEffect, useRef, useState } from 'react';
import { pgpListKeys, pgpImportKey, pgpRemoveKey } from '../../services/api';
import { useT } from '../../i18n/index.js';
import { DesktopViewEnv } from './DesktopViewEnv';
import { EncryptionView } from './views/EncryptionView';

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
    <DesktopViewEnv>
      <EncryptionView keys={keys} armored={armored} onArmored={setArmored} passphrase={passphrase} onPassphrase={setPassphrase}
        busy={busy} error={error} onImport={importKey} onRemove={fingerprint => run(() => pgpRemoveKey(fingerprint))}
        onChooseFile={() => fileRef.current?.click()}
        fileInput={<input ref={fileRef} type="file" accept=".asc,.gpg,.key,.pgp,.txt" className="hidden" onChange={pickFile} data-testid="pgp-file-input" />} />
    </DesktopViewEnv>
  );
}
