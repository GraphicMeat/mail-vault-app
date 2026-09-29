import React, { useEffect, useId, useState } from 'react';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { ToggleSwitch } from '../ui/ToggleSwitch';
import { useT } from '../../i18n/index.js';
import { send } from '../../services/transport';
import { getCachedMailboxEntry } from '../../services/db';
import { isGraphAccount } from '../../services/graphConfig';

// Names verbatim from the reply the customer was sent (plan ruling R8).
const MODES = [
  { id: 'server', titleKey: 'settings.backup.restore.mboxModeServer', hintKey: 'settings.backup.restore.mboxModeServerHint' },
  { id: 'local', titleKey: 'settings.backup.restore.mboxModeLocal', hintKey: 'settings.backup.restore.mboxModeLocalHint' },
  { id: 'folder', titleKey: 'settings.backup.restore.mboxModeFolder', hintKey: 'settings.backup.restore.mboxModeFolderHint' },
];

// Gmail's All Mail keeps no specialUse (every consumer of it would change);
// its raw LIST attribute sits in `flags` instead, read the way core
// `imap::has_attr` reads it: `All`, or `Extension("\All")`.
const isAllMail = (m) => (m.flags || []).some((f) => f === 'All' || /^Extension\("\\*All"\)$/i.test(f));
// The listing's own path, verbatim: the daemon keys folders by it (the storage
// key on Graph), so a display name or a re-cased INBOX would miss.
const inboxOf = (list) => list.find((m) => m.specialUse === '\\Inbox' || m.path.toUpperCase() === 'INBOX')?.path || 'INBOX';
const fallbackOf = (list) => (list.find(isAllMail) || list.find((m) => m.specialUse === '\\Archive'))?.path || inboxOf(list);

/**
 * Asks how to import a picked MBOX file. Collects choices only: the daemon's
 * `import_mbox` routes, dedupes and files, and `onConfirm` receives exactly
 * the params it should be sent.
 */
export default function MboxImportDialog({ sourcePath, accounts, defaultAccountId, onCancel, onConfirm }) {
  const t = useT();
  const id = useId();
  const [accountId, setAccountId] = useState(defaultAccountId);
  const [mode, setMode] = useState('local');
  const [useLabels, setUseLabels] = useState(true);
  // null until the probe and the folder list are in for this account.
  const [probe, setProbe] = useState(null);
  const [folders, setFolders] = useState([]);
  const [folder, setFolder] = useState('INBOX');
  const serverBlocked = isGraphAccount(accounts.find((a) => a.id === accountId));

  useEffect(() => {
    let live = true;
    setProbe(null);
    Promise.all([
      send('mbox_probe', { sourcePath, accountId }).catch(() => null),
      getCachedMailboxEntry(accountId),
    ]).then(([answer, entry]) => {
      if (!live) return;
      // A refresh that failed empties `mailboxes`; the daemon then routes by
      // lastKnownGoodMailboxes, so the picker offers the same list.
      const list = (entry?.mailboxes?.length ? entry.mailboxes : entry?.lastKnownGoodMailboxes || [])
        .filter((m) => m.path && !m.noselect);
      // Labels need both: with no readable folder list the daemon refuses a
      // label import (and the probe reports foldersKnown: false for it), so
      // Starred/read flags are not worth a refused import here.
      const labels = !!(answer?.hasLabels && answer?.foldersKnown);
      setFolders(list.map((m) => m.path));
      setFolder(labels ? fallbackOf(list) : inboxOf(list));
      setProbe({ labels });
    });
    return () => { live = false; };
  }, [sourcePath, accountId]);

  const changeAccount = (next) => {
    setAccountId(next);
    if (mode === 'server' && isGraphAccount(accounts.find((a) => a.id === next))) setMode('local');
  };

  const labelsOn = !!probe?.labels && useLabels;
  const options = folders.includes(folder) ? folders : [folder, ...folders];

  const confirm = () => onConfirm(mode === 'folder'
    ? { accountId, mode }
    : { accountId, mode, mailbox: folder, useLabels: labelsOn, ...(labelsOn ? { fallbackMailbox: folder } : {}) });

  return (
    <Dialog
      open
      onClose={onCancel}
      size="md"
      title={t('settings.backup.restore.importMbox')}
      data-testid="mbox-import-dialog"
      footer={(
        <>
          <Button variant="ghost" onClick={onCancel}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={!probe} onClick={confirm} data-testid="mbox-import-confirm">
            {t('settings.backup.restore.mboxImportConfirm')}
          </Button>
        </>
      )}
    >
      <div>
        <label htmlFor={`${id}-account`} className="block mb-1 text-sm text-mail-text-muted">{t('settings.backup.restore.mboxAccount')}</label>
        <select id={`${id}-account`} value={accountId} onChange={(e) => changeAccount(e.target.value)} data-testid="mbox-import-account"
          className="w-full px-3 py-2 bg-mail-bg border border-mail-border rounded-lg text-sm text-mail-text focus:border-mail-accent">
          {accounts.map((a) => <option key={a.id} value={a.id}>{a.email}</option>)}
        </select>
      </div>

      <div className="flex flex-col gap-2">
        {MODES.map((m) => {
          const blocked = m.id === 'server' && serverBlocked;
          return (
            <div key={m.id}>
              <Button variant={mode === m.id ? 'accentTint' : 'subtle'} size="lg" fullWidth className="py-3 text-left justify-start"
                aria-pressed={mode === m.id} disabled={blocked} aria-describedby={blocked ? `${id}-blocked` : undefined}
                onClick={() => setMode(m.id)} data-testid={`mbox-import-mode-${m.id}`}>
                <span className="block">
                  {t(m.titleKey)}
                  <span className="block text-xs font-normal opacity-80 mt-0.5">{t(m.hintKey)}</span>
                </span>
              </Button>
              {blocked && <p id={`${id}-blocked`} className="mt-1 text-xs text-mail-text-muted">{t('settings.backup.restore.mboxModeServerGraph')}</p>}
            </div>
          );
        })}
      </div>

      {probe && mode !== 'folder' && (
        <>
          {probe.labels && (
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm text-mail-text">
                {t('settings.backup.restore.mboxUseLabels')}
                <span className="block text-xs text-mail-text-muted">{t('settings.backup.restore.mboxUseLabelsHint')}</span>
              </span>
              <ToggleSwitch active={useLabels} onClick={() => setUseLabels((v) => !v)}
                label={t('settings.backup.restore.mboxUseLabels')} testId="mbox-import-use-labels" />
            </div>
          )}
          <div>
            <label htmlFor={`${id}-folder`} className="block mb-1 text-sm text-mail-text-muted">
              {labelsOn ? t('settings.backup.restore.mboxFallbackFolder') : t('settings.backup.restore.mboxTargetFolder')}
            </label>
            <select id={`${id}-folder`} value={folder} onChange={(e) => setFolder(e.target.value)} data-testid="mbox-import-folder"
              className="w-full px-3 py-2 bg-mail-bg border border-mail-border rounded-lg text-sm text-mail-text focus:border-mail-accent">
              {options.map((path) => <option key={path} value={path}>{path}</option>)}
            </select>
          </div>
        </>
      )}
    </Dialog>
  );
}
