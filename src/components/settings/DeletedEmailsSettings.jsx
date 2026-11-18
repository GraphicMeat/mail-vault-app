import React, { useEffect, useState } from 'react';
import { useMailStore } from '../../stores/mailStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { daemonCall } from '../../services/daemonClient';
import { recoverFromBin } from '../../services/workflows/messageMutations';
import { useT } from '../../i18n/index.js';
import { DesktopViewEnv } from './DesktopViewEnv';
import { DeletedEmailsView, RETENTION_DAYS } from './views/DeletedEmailsView';

export { RETENTION_DAYS };

/**
 * Settings > Storage > Deleted emails: the daemon's deleted-mail bin
 * (`deleted.list`), newest first, and how long it keeps them. A row goes back
 * to the server (`deleted.recover`, target server), into the vault as a local
 * copy (target local), or away for good (`deleted.discard`). The daemon owns
 * the bin; this page renders it (views/DeletedEmailsView.jsx) and asks.
 */
export function DeletedEmailsSettings() {
  const t = useT();
  const accounts = useMailStore(s => s.accounts);
  const days = useSettingsStore(s => s.deletedRetentionDays) ?? 1;
  const setDays = useSettingsStore(s => s.setDeletedRetentionDays);
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);

  const load = () => daemonCall('deleted.list')
    .then(list => setRows(list || []))
    .catch((e) => {
      console.warn('[deleted] list failed:', e);
      setRows([]);
      setError(t('deletedBin.loadFailed'));
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, []);

  // A recover's error is already catalog copy (recoverFromBin); anything
  // else says `failKey`, never the daemon's own text.
  const act = async (id, run, failKey = null) => {
    setBusy(id);
    setError(null);
    try {
      await run();
    } catch (e) {
      setError(failKey ? t(failKey) : (e?.message || t('deletedBin.recoverFailed')));
    } finally {
      setBusy(null);
      await load();
    }
  };
  const accountLabel = id => accounts.find(a => a.id === id)?.email || id;

  return <DesktopViewEnv>
    <DeletedEmailsView rows={rows} days={days} onDays={setDays} error={error} busy={busy != null} accountLabel={accountLabel}
      onRecover={id => act(id, () => recoverFromBin([id], 'server'))}
      onRecoverLocal={id => act(id, () => recoverFromBin([id], 'local'))}
      onDiscard={id => act(id, () => daemonCall('deleted.discard', { ids: [id] }), 'deletedBin.discardFailed')} />
  </DesktopViewEnv>;
}
