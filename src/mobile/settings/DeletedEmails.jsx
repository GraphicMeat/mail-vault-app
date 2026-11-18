// Settings > Storage > Deleted emails on the phone: desktop's view over the engine's bin
// (`bin.rs`, `mobile.deleted.*`), under the Storage page as on desktop.
//
// - The list is read a page at a time (`mobile.deleted.list`, Load more), and again whenever an
//   action settles (`mobile.action.result`): a delete lands in the bin when it reaches the server,
//   a recover leaves it when the message is back.
// - Recover to server journals a restore (`mobile.deleted.recover`) and answers at once; when it
//   is done the folder it went back to is synced, and when it cannot be (gone from Trash, the
//   folder gone, refused) the page says so in desktop's catalog copy. There is no Recover locally:
//   the phone keeps no vault.
// - Delete now removes the row and its kept message for good (`mobile.deleted.discard`).
// - Keep deleted emails for: the `deletedRetentionDays` preference the engine's sweep reads.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { DeletedEmailsView } from '../../components/settings/views/DeletedEmailsView';
import { daemonCall, listen } from '../transport.js';
import { useMobileStore } from '../store.js';
import { useT } from '../i18n.js';
import { SaveFailed, useSavePrefs } from './MobileViewEnv.jsx';

/** A dropped restore's reason as desktop's catalog copy. */
const failureKey = (reason) => (reason === 'GONE_FROM_TRASH' ? 'deletedBin.goneFromTrash' : 'deletedBin.recoverFailed');

export default function DeletedEmails() {
  const t = useT();
  const accounts = useMobileStore((s) => s.accounts);
  const days = useMobileStore((s) => s.prefs?.deletedRetentionDays) ?? 1;
  const [save, saveFailed] = useSavePrefs();
  const [rows, setRows] = useState(null);
  const [next, setNext] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  // Restores this page asked for: seq -> where the message goes back.
  const restores = useRef(new Map());
  useEffect(() => () => { mounted.current = false; }, []);

  const load = useCallback(async () => {
    try {
      const page = await daemonCall('mobile.deleted.list', {});
      if (!mounted.current) return;
      setRows(Array.isArray(page?.rows) ? page.rows : []);
      setNext(page?.next || null);
    } catch {
      if (!mounted.current) return;
      setRows((r) => r || []);
      setError(t('deletedBin.loadFailed'));
    }
  }, [t]);

  const more = async () => {
    if (!next) return;
    try {
      const page = await daemonCall('mobile.deleted.list', { after: next });
      if (!mounted.current) return;
      setRows((r) => [...(r || []), ...(Array.isArray(page?.rows) ? page.rows : [])]);
      setNext(page?.next || null);
    } catch {
      if (mounted.current) setError(t('deletedBin.loadFailed'));
    }
  };

  useEffect(() => {
    load();
    let stop = () => {};
    try {
      stop = listen('mobile.action.result', (result) => {
        const asked = restores.current.get(result?.seq);
        if (asked && result.outcome !== 'retrying') {
          restores.current.delete(result.seq);
          if (result.outcome === 'done') {
            daemonCall('mobile.sync.refresh', { accountId: asked.accountId, folder: asked.mailbox }).catch(() => {});
          } else if (mounted.current) {
            setError(t(failureKey(result.reason)));
          }
        }
        load();
      });
    } catch {
      // No event bridge (plain browser dev): the list is read on open and after each action.
    }
    return () => { if (typeof stop === 'function') stop(); };
  }, [load, t]);

  const act = async (run) => {
    setBusy(true);
    setError(null);
    try {
      await run();
    } finally {
      if (mounted.current) setBusy(false);
      load();
    }
  };

  const recover = (id) => act(async () => {
    const row = (rows || []).find((d) => d.id === id);
    try {
      const reply = await daemonCall('mobile.deleted.recover', { ids: [id] });
      for (const q of reply?.queued || []) {
        if (row) restores.current.set(q.seq, { accountId: row.accountId, mailbox: row.mailbox });
      }
      const failed = reply?.failed?.[0];
      if (failed && mounted.current) setError(t(failed.error || 'deletedBin.recoverFailed'));
    } catch {
      if (mounted.current) setError(t('deletedBin.recoverFailed'));
    }
  });

  const discard = (id) => act(async () => {
    try {
      await daemonCall('mobile.deleted.discard', { ids: [id] });
    } catch {
      if (mounted.current) setError(t('deletedBin.discardFailed'));
    }
  });

  const accountLabel = (id) => {
    const a = accounts.find((x) => x.id === id);
    return a ? (a.displayName || a.email) : id;
  };

  return (
    <>
      <DeletedEmailsView rows={rows} days={days} onDays={async (n) => { await save({ deletedRetentionDays: n }); load(); }}
        error={error} busy={busy} intro={t('mobile.deletedBin.intro')} accountLabel={accountLabel}
        onRecover={recover} onDiscard={discard} onMore={next ? more : undefined} />
      <SaveFailed failed={saveFailed} />
    </>
  );
}
