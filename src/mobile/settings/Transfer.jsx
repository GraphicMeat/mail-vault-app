// Settings > Accounts > Move to another computer on the phone: desktop's Export view
// (TransferExportView, desktop's Export dialog) on its own page. The chosen accounts, with their
// passwords or sign-in tokens, are sealed into a desktop `.mvtransfer` file with a password of at
// least 12 characters (`mobile.transfer.export`, engine `transfer_export.rs`: core's desktop
// mapping and `.mvtransfer` envelope), handed to the system share sheet (save to Files, AirDrop,
// ...), and deleted again as soon as the sheet answers (`mobile.transfer.discard`), whatever it
// answered. Desktop's Import opens the file. An account with no saved password or token is left
// out and named. Bringing accounts in from a computer is the QR code (ImportFromDesktop.jsx).
import React, { useEffect, useRef, useState } from 'react';
import { TransferExportView } from '../../components/settings/views/TransferExportView';
import { Button } from '../../components/ui/Button';
import { SettingsPageLayout, SettingsCard } from '../../components/ui/SettingsForm';
import { daemonCall, shareFile } from '../transport.js';
import { useMobileStore } from '../store.js';
import { useT } from '../i18n.js';
import { MobileViewEnv } from './MobileViewEnv.jsx';

const MIN_PASSWORD = 12;

export default function Transfer() {
  const t = useT();
  const accounts = useMobileStore((s) => s.accounts);
  const [left, setLeft] = useState(() => new Set()); // the accounts not chosen
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null); // { count, skipped }
  const [error, setError] = useState(null);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const chosen = accounts.filter((a) => !left.has(a.id));
  const ready = chosen.length > 0 && [...password].length >= MIN_PASSWORD && password === confirm && !busy;
  const toggle = (accountId) => setLeft((prev) => {
    const next = new Set(prev);
    if (next.has(accountId)) next.delete(accountId); else next.add(accountId);
    return next;
  });

  const run = async () => {
    setBusy(true);
    setError(null);
    setDone(null);
    let path = null;
    try {
      const reply = await daemonCall('mobile.transfer.export', { password, accountIds: chosen.map((a) => a.id) });
      if (!reply?.ok) {
        if (mounted.current) setError(reply?.code === 'PASSWORD_SHORT' ? t('settings.transfer.passwordHint', { count: MIN_PASSWORD }) : t('settings.transfer.errors.generic', { message: reply?.code || '' }));
        return;
      }
      path = reply.path;
      // The password has done its work: it does not stay on screen.
      if (mounted.current) {
        setPassword('');
        setConfirm('');
      }
      await shareFile({ path, name: reply.name, mime: 'application/octet-stream' });
      if (mounted.current) setDone({ count: reply.count, skipped: reply.skipped || [] });
    } catch (e) {
      if (mounted.current) setError(t('settings.transfer.errors.generic', { message: e?.code || e?.message || '' }));
    } finally {
      // The file holds every secret it carries: gone as soon as the sheet answers.
      if (path) await daemonCall('mobile.transfer.discard', { path }).catch(() => {});
      if (mounted.current) setBusy(false);
    }
  };

  return (
    <MobileViewEnv>
      <SettingsPageLayout data-mv-transfer>
        <SettingsCard className="space-y-4">
          <p className="text-sm text-mail-text-muted">{t('settings.transfer.description')}</p>
          <TransferExportView accounts={accounts} selected={new Set(chosen.map((a) => a.id))} onToggle={toggle} disabled={busy}
            minPassword={MIN_PASSWORD} password={password} onPassword={setPassword} confirm={confirm} onConfirm={setConfirm}
            error={error} exported={done ? done.count : null}>
            {done?.skipped.length > 0 && (
              <p className="text-sm text-mail-danger">
                {t('settings.transfer.errors.incomplete', { emails: done.skipped.map((s) => s.email).join(', ') })}
              </p>
            )}
            <Button variant="primary" fullWidth disabled={!ready} loading={busy} onClick={run}>
              {busy ? t('settings.transfer.encrypting') : t('settings.transfer.exportTitle')}
            </Button>
          </TransferExportView>
        </SettingsCard>
      </SettingsPageLayout>
    </MobileViewEnv>
  );
}
