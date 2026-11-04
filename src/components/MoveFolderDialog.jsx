import React, { useEffect, useMemo, useRef, useState } from 'react';
import { FolderInput, FolderSymlink, Loader2, Search } from 'lucide-react';
import { Dialog } from './ui/Dialog';
import { Button } from './ui/Button';
import { useAccountStore } from '../stores/accountStore';
import { useSettingsStore, getAccountColor, getAccountInitial, hasPremiumAccess } from '../stores/settingsStore';
import { usePrivateAttr } from '../hooks/usePrivacy';
import { useT } from '../i18n/index.js';
import { mailboxLabel, decodeImapUtf7 } from '../utils/imapUtf7';
import { IS_APPSTORE_BUILD } from '../utils/buildFlags';
import { selectableFolders } from './MoveToFolderDropdown';
import * as move from '../services/folderMove';

// The row that makes the moved folder a new top-level folder.
const TOP = '';

// Another account's folders: its cached list, else listed live (credentials
// resolved, Graph folders with their ids). The live listing writes no cache,
// so the daemon's plan for it says `cached: false`.
async function foldersOf(account) {
  const { getCachedMailboxes } = await import('../services/db');
  const cached = await getCachedMailboxes(account.id).catch(() => null);
  if (cached?.length) return cached;
  const { fetchAccountMailboxes } = await import('../services/workflows/activateAccount');
  return fetchAccountMailboxes(account);
}

/**
 * Move folder: an account (the folder's own preselected) and a folder in it
 * that becomes the moved folder's parent, or the top level. Each pick asks the
 * daemon for the plan from its cached lists (what moves, or why not); Confirm
 * starts the job and closes: the move's progress is the corner chip's
 * (FolderMoveProgress), never this dialog's. Another account is a Premium
 * destination, the folder's own account is free (a UI gate, like the
 * migration's). `node` is the sidebar's folder, `accountId` its account.
 */
export function MoveFolderDialog({ node, accountId, mailboxes, onClose, onUpgrade }) {
  const t = useT();
  const pa = usePrivateAttr();
  const accounts = useAccountStore(s => s.accounts) || [];
  const accountColors = useSettingsStore(s => s.accountColors);
  const premium = useSettingsStore(s => hasPremiumAccess(s.billingProfile));
  const [destId, setDestId] = useState(accountId);
  const [listing, setListing] = useState({ boxes: mailboxes, loading: false, failed: false });
  const [filter, setFilter] = useState('');
  const [target, setTarget] = useState(null); // { path: string|null, folderId? }
  const [plan, setPlan] = useState(null); // the daemon's answer, or { pending: true }
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState(null); // catalog key of a refused start
  const asked = useRef(0);

  const same = destId === accountId;
  const locked = !same && !premium;
  const name = mailboxLabel(node.name);
  const d = node.delimiter || (mailboxes || []).find(m => m.delimiter)?.delimiter || '/';
  const insideSource = (path) => same && (path === node.path || path.startsWith(node.path + d));

  useEffect(() => {
    if (same || locked) { setListing({ boxes: same ? mailboxes : [], loading: false, failed: false }); return undefined; }
    const account = accounts.find(a => a.id === destId);
    let alive = true;
    setListing({ boxes: [], loading: true, failed: false });
    foldersOf(account).then(
      (boxes) => { if (alive) setListing({ boxes: boxes || [], loading: false, failed: false }); },
      (e) => {
        console.warn('[folderMove] could not list the folders:', e?.message || e);
        if (alive) setListing({ boxes: [], loading: false, failed: true });
      },
    );
    return () => { alive = false; };
    // The account list and the open account's folders do not change the pick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [destId, same, locked]);

  const folders = useMemo(() => {
    const all = selectableFolders(listing.boxes);
    const q = filter.trim().toLowerCase();
    if (!q) return all;
    return all.filter(mb => mailboxLabel(mb.name).toLowerCase().includes(q) || decodeImapUtf7(mb.path).toLowerCase().includes(q));
  }, [listing.boxes, filter]);
  const searching = filter.trim().length > 0;

  const params = (picked) => ({
    sourceAccountId: accountId,
    sourcePath: node.path,
    ...(node._graphFolderId ? { sourceFolderId: node._graphFolderId } : {}),
    destAccountId: destId,
    destPath: picked.path,
    ...(picked.folderId ? { destFolderId: picked.folderId } : {}),
  });

  const pick = (path, folderId) => {
    const picked = { path, folderId };
    const n = ++asked.current;
    setTarget(picked);
    setError(null);
    setPlan({ pending: true });
    // Only the answer for the latest pick counts. A folder the daemon's
    // cached list lacks is no refusal: its list may trail the one on screen,
    // and the job plans again from a live listing (as `folder_move.start` does).
    move.plan(params(picked)).then(
      (answer) => {
        if (n !== asked.current) return;
        setPlan(!answer || answer.refusal === 'E_FOLDER_MOVE_NOT_FOUND' ? { cached: false } : answer);
      },
      (e) => {
        console.warn('[folderMove] no plan:', e?.message || e);
        if (n === asked.current) setPlan({ cached: false });
      },
    );
  };

  const chooseAccount = (id) => {
    asked.current += 1;
    setDestId(id);
    setTarget(null);
    setPlan(null);
    setError(null);
    setFilter('');
  };

  const confirm = async () => {
    setStarting(true);
    setError(null);
    try {
      await move.start(params(target));
      onClose();
    } catch (e) {
      console.warn('[folderMove] the move did not start:', e?.message || e);
      setError(move.errorKey(e));
      setStarting(false);
    }
  };

  const ready = !!target && !!plan && !plan.pending && !plan.refusal && !locked && !starting;
  const destAccount = accounts.find(a => a.id === destId);
  const copies = plan && !plan.pending && !plan.refusal && !plan.fastRename;
  const isPicked = (path) => !!target && target.path === path;

  const row = (path, label, { depth = 0, folderId, disabled = false, title } = {}) => (
    <button
      key={path ?? TOP}
      type="button"
      role="radio"
      aria-checked={isPicked(path)}
      data-testid="move-folder-target"
      data-path={path ?? TOP}
      disabled={disabled}
      title={title}
      onClick={() => pick(path, folderId)}
      className={`w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left rounded-lg transition-colors disabled:opacity-50 ${
        isPicked(path) ? 'bg-mail-accent/10 text-mail-accent-text' : 'text-mail-text hover:bg-mail-surface-hover'}`}
      style={{ paddingLeft: `${12 + depth * 16}px` }}
    >
      <FolderSymlink size={14} className="text-mail-text-muted flex-shrink-0" />
      <span className="truncate">{label}</span>
    </button>
  );

  return (
    <Dialog
      open
      onClose={onClose}
      // Not while the start is on its way: a refusal is said here.
      dismissable={!starting}
      size="md"
      portal
      title={t('folderMove.title', { name })}
      icon={<FolderInput size={20} className="text-mail-accent-text" />}
      data-testid="move-folder-dialog"
      footer={(
        <>
          <Button variant="secondary" fullWidth onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" fullWidth disabled={!ready} loading={starting} onClick={confirm}>{t('folderMove.confirm')}</Button>
        </>
      )}
    >
      <div className="flex items-center gap-2">
        {destAccount && (
          <div aria-hidden="true" className="w-6 h-6 rounded-full flex items-center justify-center text-white text-xs font-bold flex-shrink-0"
            style={{ backgroundColor: getAccountColor(accountColors, destAccount) }}>
            {getAccountInitial(destAccount)}
          </div>
        )}
        <label className="sr-only" htmlFor="move-folder-account">{t('folderMove.account')}</label>
        <select id="move-folder-account" value={destId} onChange={(e) => chooseAccount(e.target.value)}
          className="flex-1 min-w-0 bg-mail-input-bg border border-mail-border rounded-lg px-3 py-2 text-sm text-mail-text">
          {accounts.map(a => (
            <option key={a.id} value={a.id}>
              {a.id === accountId || premium ? pa(a.email, 'email') : t('folderMove.accountLocked', { email: pa(a.email, 'email') })}
            </option>
          ))}
        </select>
      </div>

      {locked ? (
        <div className="space-y-3" data-testid="move-folder-upsell">
          <p className="text-sm text-mail-text-muted">{t('folderMove.premiumUpsell')}</p>
          {!IS_APPSTORE_BUILD && onUpgrade && (
            <Button variant="primary" onClick={() => { onClose(); onUpgrade(); }}>{t('common.upgrade')}</Button>
          )}
        </div>
      ) : (
        <div>
          <p className="text-xs font-medium text-mail-text-muted mb-1.5">{t('folderMove.into')}</p>
          <div className="flex items-center gap-2 px-2 py-1.5 mb-1 bg-mail-surface rounded-lg">
            <Search size={14} className="text-mail-text-muted flex-shrink-0" />
            <input type="text" value={filter} onChange={(e) => setFilter(e.target.value)}
              placeholder={t('moveTo.searchFolders')} aria-label={t('moveTo.searchFolders')}
              className="bg-transparent text-sm text-mail-text placeholder:text-mail-text-muted outline-none w-full" />
          </div>
          <div role="radiogroup" aria-label={t('folderMove.into')} className="max-h-64 overflow-y-auto border border-mail-border rounded-lg p-1">
            {listing.loading ? (
              <p className="flex items-center gap-2 px-3 py-2 text-sm text-mail-text-muted">
                <Loader2 size={14} className="animate-spin" />{t('folderMove.loadingFolders')}
              </p>
            ) : listing.failed ? (
              <p className="px-3 py-2 text-sm text-mail-danger">{t('folderMove.foldersFailed')}</p>
            ) : (
              <>
                {row(null, t('folderMove.topLevel', { name }))}
                {folders.map(f => row(f.path, searching ? f.trail.slice(-2).join(' › ') : mailboxLabel(f.name), {
                  depth: searching ? 0 : f.depth,
                  folderId: f._graphFolderId,
                  disabled: insideSource(f.path),
                  title: f.trail.join(' › '),
                }))}
              </>
            )}
          </div>
        </div>
      )}

      {plan && !plan.pending && (
        <div className="space-y-1 text-xs" role="status" aria-live="polite">
          {plan.refusal ? (
            <p className="text-mail-danger">{t(move.errorKey(plan.refusal))}</p>
          ) : (
            <>
              {plan.cached && plan.items?.length > 0 && !plan.fastRename && (
                <p className="text-mail-text">{t('folderMove.planCount', { count: plan.items.length })}</p>
              )}
              {!plan.cached && <p className="text-mail-text-muted">{t('folderMove.planUnknown')}</p>}
              {plan.fastRename && <p className="text-mail-text-muted">{t('folderMove.fastRename')}</p>}
              {copies && <p className="text-mail-text-muted">{t('folderMove.retireNote')}</p>}
              {copies && <p className="text-mail-text-muted">{t('folderMove.vaultNote')}</p>}
            </>
          )}
        </div>
      )}
      {error && <p className="text-xs text-mail-danger">{t(error)}</p>}
    </Dialog>
  );
}
