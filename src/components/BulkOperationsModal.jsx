import React, { useState, useMemo, useEffect, useRef, useId } from 'react';
import { Dialog } from './ui/Dialog';
import { Button } from './ui/Button';
import { X, Archive, ArchiveRestore, Trash2, ArrowRight, ArrowLeft, AlertTriangle, HardDrive, Calendar } from 'lucide-react';
import { useMessageListStore } from '../stores/messageListStore';
import { useMailStore } from '../stores/mailStore';
import { useSettingsStore } from '../stores/settingsStore';
import * as db from '../services/db';
import { vaultClause } from '../utils/custodyCopy';
import { t as tr, t, useT   } from '../i18n/index.js';
import { T } from '../i18n/T.jsx';

const ACTION_STYLES = () => ({
  archive: {
    color: 'var(--mail-local)',
    iconColor: 'text-mail-local',
    confirmLabel: tr('common.archive'),
  },
  delete: {
    color: 'var(--mail-danger)',
    iconColor: 'text-mail-danger',
    confirmLabel: tr('rowMenu.deleteServer'),
  },
  archive_and_delete: {
    color: 'var(--mail-local)',
    iconColor: 'text-mail-local',
    confirmLabel: tr('bulk.ops.archiveDelete2'),
  },
  unarchive: {
    color: 'var(--mail-warning)',
    iconColor: 'text-mail-warning',
    confirmLabel: tr('rowMenu.unarchive'),
  },
  delete_everywhere: {
    color: 'var(--mail-danger)',
    iconColor: 'text-mail-danger',
    confirmLabel: tr('rowMenu.deleteEverywhere'),
  },
});

// The last screen before thousands of messages move. It has to name the
// action it is about to run, and describe only what that action actually
// costs. It used to show one generic "Are you sure? This will permanently
// delete N emails from the server. This cannot be undone." for both plain
// Delete and Archive & Delete — so the product's flagship operation, which
// copies into the vault and verifies each message before the server delete,
// warned that the mail was about to be destroyed for good.
const CONFIRM_COPY = () => ({
  delete: {
    title: tr('rowMenu.deleteServer2'),
    lead: (n) => `Remove ${n.toLocaleString()} emails from the server.`,
    detail: (n, inVault) => vaultClause(n, inVault),
    confirmLabel: tr('rowMenu.deleteServer'),
  },
  archive_and_delete: {
    title: tr('bulk.ops.archiveThenDeleteServer'),
    lead: (n) => `Copy ${n.toLocaleString()} emails into your vault, then remove them from the server.`,
    // True of the run, not a reassurance: BulkOperationManager archives,
    // verifies, and deletes only the uids that came back verified.
    detail: () => 'Each email is verified in your vault before it leaves the server. Anything that fails to copy stays on the server.',
    confirmLabel: tr('bulk.ops.archiveDelete2'),
  },
  delete_everywhere: {
    title: tr('rowMenu.deleteEverywhere2'),
    lead: (n) => `Remove ${n.toLocaleString()} emails from the server, your vault, and your backup drive.`,
    detail: () => 'No copy will be left anywhere. This cannot be undone.',
    confirmLabel: tr('rowMenu.deleteEverywhere'),
  },
});

function actionBg(color, pct) {
  return `color-mix(in srgb, ${color} ${pct}%, transparent)`;
}

export function BulkOperationsModal({ isOpen, onClose, onConfirm }) {
  const t = useT();
  const bulkSession = useMessageListStore(s => s.bulkSession);
  const setBulkSession = useMessageListStore(s => s.setBulkSession);
  const setSelection = useMessageListStore(s => s.setSelection);
  const endBulkSession = useMessageListStore(s => s.endBulkSession);
  const selectedEmailIds = useMessageListStore(s => s.selectedEmailIds);

  const step = bulkSession?.step ?? 1;
  const selectedRange = bulkSession?.range ?? null;
  const selectedAction = bulkSession?.action ?? null;
  const setStep = (v) => setBulkSession({ step: v });
  // Every range control (year buttons, presets, the Custom Range toggle) goes
  // through this one setter, so it's the single place to mark "a user just
  // clicked a range control" — a ref bump, not state, since it only needs to
  // be readable inside the sync effect below, not to trigger a render itself
  // (the setBulkSession call right after already does that).
  const rangePickRef = useRef(0);
  const setSelectedRange = (v) => { rangePickRef.current += 1; setBulkSession({ range: v }); };
  const setSelectedAction = (v) => setBulkSession({ action: v });

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');

  const sortedEmails = useMessageListStore(s => s.sortedEmails);
  const totalEmails = useMessageListStore(s => s.totalEmails);
  const archivedEmailIds = useMessageListStore(s => s.archivedEmailIds);
  const activeAccountId = useMessageListStore(s => s.activeAccountId);
  const activeMailbox = useMessageListStore(s => s.activeMailbox);
  const viewMode = useMessageListStore(s => s.viewMode);
  const unifiedInbox = useMessageListStore(s => s.unifiedInbox);
  // The brief pointed at backupStore.js for this, but that store only holds
  // ephemeral progress — the actual configured location (or null) lives in
  // settingsStore as `externalBackupLocation`. Any non-null value means the
  // user has pointed the app at a folder, regardless of its current status
  // (ready/needs_reauth/unavailable/invalid) — "configured" is about intent,
  // not live health, so this stays a presence check.
  const hasBackupConfigured = useSettingsStore(s => !!s.externalBackupLocation);

  // `sortedEmails` is the paginated render window, not the mailbox — on a 15k
  // INBOX it holds whatever pagination has drained so far, so selecting "All"
  // used to mean "all 741 currently on screen". The sidecar cache already has
  // the whole mailbox, so read uid+date straight from it instead.
  const [cachedRows, setCachedRows] = useState(null);
  const [loadingPool, setLoadingPool] = useState(false);
  // What (account, mailbox) `cachedRows` currently reflects. Lets the effect
  // below tell "just minimized" (isOpen alone changed — keep the pool) apart
  // from "the mailbox underneath changed" (must invalidate, isOpen or not).
  // EmailList ends the whole bulk session on a mailbox switch, so this is
  // belt-and-suspenders for the modal's own cache rather than the primary
  // guard — but it must hold on its own, since nothing else clears cachedRows.
  const cachedForRef = useRef(null);

  useEffect(() => {
    // Local view shows archived-only, and unified spans accounts — neither maps
    // to one mailbox's cache, so both keep using the window.
    if (!activeAccountId || unifiedInbox || viewMode === 'local') {
      setCachedRows(null);
      setLoadingPool(false);
      cachedForRef.current = null;
      return;
    }
    const identity = `${activeAccountId}|${activeMailbox}`;
    if (cachedForRef.current !== identity) {
      // The mailbox this pool was fetched for no longer matches — a stale
      // pool from a different mailbox must not linger, minimized or not.
      setCachedRows(null);
      cachedForRef.current = null;
    }
    // Don't fetch while minimized, but don't discard what's already loaded
    // for THIS mailbox either: the bulk session and its selection survive a
    // minimize, and the selection-sync effect below re-syncs whenever the
    // pool changes — nulling it here would read as "the pool shrank" and
    // wipe a hand-edited checkbox for no reason other than the modal being
    // hidden.
    if (!isOpen) { setLoadingPool(false); return; }
    let cancelled = false;
    setLoadingPool(true);
    (async () => {
      try {
        const listing = await db.listCachedUids(activeAccountId, activeMailbox);
        if (cancelled || !listing?.uids?.length) return;
        // ponytail: one call for the whole mailbox — 15k sidecar reads and a
        // ~13MB reply. Same shape the cache drain already runs; chunk it if a
        // bigger mailbox ever makes the modal stall on open.
        const rows = await db.getEmailHeadersByUids(activeAccountId, activeMailbox, listing.uids);
        if (cancelled || !rows.length) return;
        // The cache outlives the list's own filtering, so re-apply it here:
        // messages the user deleted (tombstoned, awaiting reconcile) or the
        // server flagged \Deleted are hidden from the list and must not be
        // silently re-archived or re-deleted by a bulk run.
        const { deleteTombstones, archivedEmailIds: archived } = useMailStore.getState();
        const mbox = activeMailbox === 'UNIFIED' ? 'INBOX' : activeMailbox;
        // Newest first, same order the list renders and the drain reads in —
        // bulk progress then works down from the most recent message.
        setCachedRows(rows
          .filter(e => !deleteTombstones?.has(`${activeAccountId}|${mbox}|${e.uid}`))
          .filter(e => archived.has(e.uid) || !e.flags?.includes('\\Deleted'))
          .map(e => ({ uid: e.uid, date: e.date || e.internalDate }))
          .sort((a, b) => b.uid - a.uid));
        cachedForRef.current = identity;
      } catch (e) {
        console.warn('[BulkOperationsModal] Cache read failed, using loaded window:', e);
      } finally {
        if (!cancelled) setLoadingPool(false);
      }
    })();
    return () => { cancelled = true; };
  }, [isOpen, activeAccountId, activeMailbox, unifiedInbox, viewMode]);

  // Messages archived locally after being deleted from the server have no
  // sidecar, so they only exist in the window — keep them selectable.
  const emailPool = useMemo(() => {
    if (!cachedRows) return sortedEmails;
    const cachedUids = new Set(cachedRows.map(e => e.uid));
    const localOnly = sortedEmails.filter(e => !cachedUids.has(e.uid));
    return localOnly.length ? [...cachedRows, ...localOnly] : cachedRows;
  }, [cachedRows, sortedEmails]);

  // Compute available years from the selectable pool
  const emailYears = useMemo(() => {
    const years = new Map(); // year -> count
    for (const email of emailPool) {
      const date = email.date ? new Date(email.date) : null;
      if (date && !isNaN(date)) {
        const y = date.getFullYear();
        years.set(y, (years.get(y) || 0) + 1);
      }
    }
    return [...years.entries()].sort((a, b) => b[0] - a[0]);
  }, [emailPool]);

  // Filter emails by selected range
  const selectedEmails = useMemo(() => {
    if (!selectedRange) return [];
    const now = new Date();

    return emailPool.filter(email => {
      const date = email.date ? new Date(email.date) : null;
      if (!date || isNaN(date)) return false;

      switch (selectedRange.type) {
        case 'all':
          return true;
        case 'year':
          return date.getFullYear() === selectedRange.year;
        case 'today': {
          const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
          return date >= start;
        }
        case 'yesterday': {
          const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
          const dayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate());
          return date >= dayStart && date < dayEnd;
        }
        case 'last_week':
          return (now - date) <= 7 * 24 * 60 * 60 * 1000;
        case 'last_30':
          return (now - date) <= 30 * 24 * 60 * 60 * 1000;
        case 'last_90':
          return (now - date) <= 90 * 24 * 60 * 60 * 1000;
        case 'this_year':
          return date.getFullYear() === now.getFullYear();
        case 'last_year':
          return date.getFullYear() === now.getFullYear() - 1;
        case 'custom': {
          const from = customFrom ? new Date(customFrom) : new Date(0);
          const to = customTo ? new Date(customTo + 'T23:59:59') : now;
          return date >= from && date <= to;
        }
        default:
          return false;
      }
    });
  }, [selectedRange, emailPool, customFrom, customTo]);

  // The range is only a *description* of a selection. Writing the resolved uids
  // into the store is what checkmarks the rows, and what lets the user add or
  // remove messages by hand before pressing Start.
  //
  // The actual contract (three lines, read them before "fixing" this again):
  //   1. An explicit click on a range control (a year button, a preset, the
  //      Custom Range toggle) ALWAYS re-derives that range — even a redundant
  //      click on the control that's already active, and even over a
  //      hand-narrowed selection. The click is what re-derivation means; a
  //      range button that silently no-ops when clicked is worse than
  //      superseding a hand edit.
  //   2. Nothing else re-derives: not a bare minimize/reopen, not the sidecar
  //      cache settling and then churning further (new mail, a flag flip, a
  //      tombstone reconcile), not any other background sync. Only rule 1
  //      writes a selection.
  //   3. Do NOT skip the click-counter bump in `setSelectedRange` when the new
  //      range value equals the current one ("nothing changed, why write?").
  //      That equality is exactly what the reachable defect looks like: pick
  //      "All", have something external empty `selectedEmailIds` (e.g. the
  //      selection action bar's Clear), then re-click "All" — same value,
  //      must still re-derive. Value-equality skips rule 1 the moment it
  //      matters and reopens that defect (e2e:
  //      `connected-bulk-delete-everywhere.test.js`, `Expected: 3, Received: 0`).
  //
  // Mechanically: the modal never unmounts on minimize (isOpen just makes it
  // render null), so this effect stays live across a minimize/reopen cycle
  // and across any background churn while minimized — rule 2 above. The one
  // legitimate non-click trigger is the pool still *settling*: a range picked
  // before the sidecar cache read lands must still widen once it does, so
  // pool size counts toward the signature only until `cachedRows` first lands
  // — `cachedRows === null` is "still on the window fallback, widen still
  // pending"; once populated, later size changes (a fresh fetch after
  // `cachedRows` resets, or plain window churn folded into `emailPool`) are
  // frozen out, same as any other background churn.
  const lastSyncedRangeRef = useRef(null);
  useEffect(() => {
    if (!selectedRange) { lastSyncedRangeRef.current = null; return; }
    // This modal is a child of EmailList, whose own effect ends a session
    // bound to a different (account, mailbox, viewMode) than the live one.
    // Without this check, correctness here would rest on an implicit
    // child-before-parent effect-ordering guarantee — this effect running
    // and writing a transiently-wrong selection before EmailList's sibling
    // effect ends the session, one commit later — rather than on an explicit
    // guard. Do NOT delete this as "redundant" with that teardown: it's what
    // makes the teardown a cleanup instead of a race it happens to win.
    if (bulkSession.accountId !== activeAccountId || bulkSession.mailbox !== activeMailbox || bulkSession.viewMode !== viewMode) {
      return;
    }
    const poolPart = cachedRows === null ? emailPool.length : 'settled';
    // `rangePickRef` only moves on an explicit click of a range control (see
    // setSelectedRange above) — never on background churn (new mail, a flag
    // flip, a tombstone reconcile all change `emailPool`/`selectedEmails`,
    // which re-run this effect, but don't touch the ref). Folding it into the
    // signature means a re-pick of the identical range always produces a
    // fresh signature — closing the "something external emptied
    // selectedEmailIds, re-picking the same range did nothing" defect —
    // while a signature match still means exactly "nothing a user did
    // changed", so routine sync churn can never silently resurrect a
    // selection the user (or another workflow) just cleared.
    const signature = `${JSON.stringify(selectedRange)}|${poolPart}|${customFrom}|${customTo}|${rangePickRef.current}`;
    if (lastSyncedRangeRef.current === signature) return;
    lastSyncedRangeRef.current = signature;
    setSelection(selectedEmails.map(e => e.uid));
  }, [selectedRange, bulkSession, activeAccountId, activeMailbox, viewMode, cachedRows, emailPool.length, customFrom, customTo, selectedEmails, setSelection]);

  // Live count, not the range's own result — hand edits made while the modal
  // was minimized must be reflected here and must be what Start acts on.
  const selectedCount = selectedRange ? selectedEmailIds.size : 0;
  const liveUids = () => [...selectedEmailIds];
  const isPartialLoad = !loadingPool && emailPool.length < totalEmails;

  // Same live-selection principle as selectedCount: once a hand edit diverges
  // from the range's own result, the archived-locally warning, the Unarchive
  // option, the legend, and the Delete-from-Server description must all
  // follow the checkboxes, not the stale range. One traversal shared by all
  // four consumers — selections here can reach ~15k, so this must not be a
  // count computed once per consumer.
  const archivedSelectedCount = useMemo(() => {
    let n = 0;
    for (const uid of selectedEmailIds) if (archivedEmailIds.has(uid)) n++;
    return n;
  }, [selectedEmailIds, archivedEmailIds]);
  const hasArchivedSelected = archivedSelectedCount > 0;

  // "Delete from Server" must not claim a copy survives when none does.
  // Derived from the same archivedSelectedCount/selectedCount the legend
  // already shows, not a fresh traversal — the two must always agree.
  //
  // No backup claim here, on purpose: hasBackupConfigured is a settings/intent
  // flag (a location is set up), not proof these specific uids have actually
  // been mirrored — backup is an async dual-write, and an archived-but-not-yet-
  // backed-up email is a real, queued state (src-tauri/src/backup.rs). We
  // deliberately don't walk the mirror on modal open to answer that, so this
  // description doesn't assert what it hasn't checked. "Remove from server
  // only" already tells the user the other two locations aren't touched; the
  // legend above states whether a backup is configured without claiming contents.
  const deleteDescription = archivedSelectedCount === 0
    ? t('bulk.ops.removeServerNoCopyVault')
    : archivedSelectedCount < selectedCount
      ? t('bulk.ops.removeServerOnlyOnlyEmails')
      : t('bulk.ops.removeServerOnlyVaultKeeps');

  const handleConfirm = () => {
    if (selectedAction === 'delete' || selectedAction === 'archive_and_delete' || selectedAction === 'delete_everywhere') {
      setShowDeleteConfirm(true);
      return;
    }
    const uids = liveUids();
    onConfirm({ action: selectedAction, uids });
    handleMinimize();
  };

  const handleDeleteConfirm = () => {
    const uids = liveUids();
    onConfirm({ action: selectedAction, uids });
    handleMinimize();
  };

  // Backdrop, X and Escape MINIMIZE — the session and its selection survive so
  // the bubble can carry them. Only Cancel ends the session.
  //
  // `onClose` is minimizeBulkModal, wired by the parent (EmailList) — it's the
  // single owner of "minimize" the store's state, so this just delegates to
  // it rather than also calling minimizeBulkModal directly (that fired the
  // same store update twice per minimize).
  const handleMinimize = () => {
    setShowDeleteConfirm(false);
    onClose();
  };

  // endBulkSession already flips bulkModalOpen to false (same as onClose
  // would), so cancel only needs its own action — no redundant onClose() too.
  const handleCancel = () => {
    setShowDeleteConfirm(false);
    setCustomFrom('');
    setCustomTo('');
    endBulkSession();
  };

  const titleId = useId();

  return (
    <Dialog
      open={isOpen}
      // Backdrop and Escape MINIMIZE — the session and its selection survive
      // so the bubble can carry them. Only Cancel ends the session.
      onClose={handleMinimize}
      padded={false}
      aria-labelledby={titleId}
      panelClassName="overflow-hidden"
    >
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-4 border-b border-mail-border">
            <h2 id={titleId} className="text-lg font-semibold text-mail-text">
              {showDeleteConfirm
                ? CONFIRM_COPY()[selectedAction].title
                : step === 1 ? t('bulk.ops.bulkEmailOperations') : t('bulk.ops.chooseActionEmails', { selectedCount: selectedCount.toLocaleString() })}
            </h2>
            <Button variant="ghost" icon size="xs" onClick={handleMinimize} aria-label={t('common.minimize')} title={t('bulk.ops.minimizeSelectionKept')}>
              <X size={18} />
            </Button>
          </div>

          {/* Delete confirmation */}
          {showDeleteConfirm ? (
            <div className="p-5">
              <div className="flex items-start gap-3 p-4 bg-mail-danger-tint border border-mail-danger/20 rounded-lg mb-4">
                <AlertTriangle size={20} className="text-mail-danger flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-medium text-mail-text">
                    {CONFIRM_COPY()[selectedAction].lead(selectedCount)}
                  </p>
                  <p className="text-xs text-mail-text-muted mt-1">
                    {CONFIRM_COPY()[selectedAction].detail(selectedCount, archivedSelectedCount)}
                  </p>
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" className="hover:bg-mail-border"
                  onClick={() => setShowDeleteConfirm(false)}
                >
                  {t('common.cancel')}
                </Button>
                <button
                  onClick={handleDeleteConfirm}
                  data-testid="bulk-delete-confirm"
                  className="px-4 py-2 text-sm font-medium bg-mail-danger text-white rounded-lg
                            hover:bg-mail-danger/90 transition-colors"
                >
                  {CONFIRM_COPY()[selectedAction].confirmLabel}
                </button>
              </div>
            </div>
          ) : step === 1 ? (
            /* Step 1: Date Range */
            <div className="p-5">
              {loadingPool && (
                <div className="flex items-start gap-2 p-3 bg-mail-surface border border-mail-border rounded-lg mb-4">
                  <p className="text-xs text-mail-text-muted">{t('bulk.ops.readingAllEmails', { count: totalEmails.toLocaleString() })}</p>
                </div>
              )}

              {isPartialLoad && (
                <div className="flex items-start gap-2 p-3 bg-mail-warning-tint border border-mail-warning/20 rounded-lg mb-4">
                  <AlertTriangle size={16} className="text-mail-warning flex-shrink-0 mt-0.5" />
                  <p className="text-xs text-mail-text-muted">
                    {t('bulk.ops.availableLocallyOnlyThoseSelected', { pool: emailPool.length.toLocaleString(), total: totalEmails.toLocaleString() })}
                  </p>
                </div>
              )}

              {/* Per-year buttons */}
              {emailYears.length > 0 && (
                <div className="mb-4">
                  <label className="text-xs font-medium text-mail-text-muted uppercase tracking-wide mb-2 block">{t('bulk.ops.year')}</label>
                  <div className="flex flex-wrap gap-2">
                    {emailYears.map(([year, count]) => {
                      const isActive = selectedRange?.type === 'year' && selectedRange?.year === year;
                      return (
                        <button
                          key={year}
                          onClick={() => setSelectedRange({ type: 'year', year })}
                          className={`px-3 py-1.5 text-sm rounded-lg border transition-colors ${
                            isActive
                              ? 'bg-mail-accent-fill text-white border-mail-accent'
                              : 'bg-mail-surface border-mail-border text-mail-text hover:bg-mail-surface-hover'
                          }`}
                        >
                          {year} ({count.toLocaleString()})
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Relative presets */}
              <div className="mb-4">
                <label className="text-xs font-medium text-mail-text-muted uppercase tracking-wide mb-2 block">{t('bulk.ops.presets')}</label>
                <div className="flex flex-wrap gap-2">
                  {[
                    { type: 'today', label: t('bulk.ops.today') },
                    { type: 'yesterday', label: t('bulk.ops.yesterday') },
                    { type: 'last_week', label: t('bulk.ops.lastWeek') },
                    { type: 'last_30', label: t('bulk.ops.last30Days') },
                    { type: 'last_90', label: t('bulk.ops.last90Days') },
                    { type: 'this_year', label: t('bulk.ops.year2') },
                    { type: 'last_year', label: t('bulk.ops.lastYear') },
                    { type: 'all', label: 'All' },
                  ].map(preset => {
                    const isActive = selectedRange?.type === preset.type;
                    return (
                      <button
                        key={preset.type}
                        onClick={() => setSelectedRange({ type: preset.type })}
                        className={`px-3 py-1.5 text-sm rounded-lg border transition-colors ${
                          isActive
                            ? 'bg-mail-accent-fill text-white border-mail-accent'
                            : 'bg-mail-surface border-mail-border text-mail-text hover:bg-mail-surface-hover'
                        }`}
                      >
                        {preset.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Custom range */}
              <div className="mb-4">
                <button
                  onClick={() => setSelectedRange({ type: 'custom' })}
                  className={`flex items-center gap-1.5 text-sm mb-2 ${
                    selectedRange?.type === 'custom' ? 'text-mail-accent-text font-medium' : 'text-mail-text-muted hover:text-mail-text'
                  }`}
                >
                  <Calendar size={14} />
                  {t('bulk.ops.customRange')}
                </button>
                {selectedRange?.type === 'custom' && (
                  <div className="flex items-center gap-2">
                    <input
                      type="date"
                      value={customFrom}
                      onChange={(e) => setCustomFrom(e.target.value)}
                      className="px-2 py-1.5 text-sm bg-mail-surface border border-mail-border rounded-lg
                                text-mail-text focus:border-mail-accent outline-none"
                    />
                    <span className="text-mail-text-muted text-sm">{t('bulk.ops.to')}</span>
                    <input
                      type="date"
                      value={customTo}
                      onChange={(e) => setCustomTo(e.target.value)}
                      className="px-2 py-1.5 text-sm bg-mail-surface border border-mail-border rounded-lg
                                text-mail-text focus:border-mail-accent outline-none"
                    />
                  </div>
                )}
              </div>

              {/* Footer */}
              <div className="flex items-center justify-between pt-3 border-t border-mail-border">
                <span className="text-sm text-mail-text-muted">
                  {selectedCount > 0 ? t('bulk.ops.emailsSelected', { selectedCount: selectedCount.toLocaleString() }) : t('bulk.ops.selectDateRange')}
                </span>
                <div className="flex gap-2">
                  <Button variant="ghost" className="hover:bg-mail-border"
                    onClick={handleCancel}
                  >
                    {t('common.cancel')}
                  </Button>
                  <button
                    onClick={() => setStep(2)}
                    disabled={selectedCount === 0 || loadingPool}
                    className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-mail-accent-fill text-white
                              rounded-lg hover:bg-mail-accent/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {t('common.next')}
                    <ArrowRight size={14} />
                  </button>
                </div>
              </div>
            </div>
          ) : (
            /* Step 2: Action Selection */
            <div className="p-5">
              {/* Which of the three storage locations this selection occupies.
                  No backup count — reading it means resolving the bookmark and
                  walking the mirror on modal open, i.e. spinning up a drive for
                  a number nobody asked for. */}
              <div className="flex items-center gap-2 mb-3 text-xs text-mail-text-muted">
                <span>{t('bulk.ops.onServerCount', { count: selectedCount.toLocaleString() })}</span>
                <span>·</span>
                <span>{t('bulk.ops.archivedHereCount', { count: archivedSelectedCount.toLocaleString() })}</span>
                {hasBackupConfigured && (<><span>·</span><span>{t('bulk.ops.backupConfigured')}</span></>)}
              </div>
              {/* Warning for locally-stored emails */}
              {hasArchivedSelected && (
                <div className="flex items-start gap-2 p-3 mb-3 rounded-lg bg-mail-warning/10 border border-mail-warning/30">
                  <AlertTriangle size={14} className="text-mail-warning flex-shrink-0 mt-0.5" />
                  <p className="text-xs text-mail-text">
                    <T k="bulk.ops.vaultHoldsSomeUnarchiveIsRisky"
                       parts={[(s) => <strong>{s}</strong>]} />
                  </p>
                </div>
              )}
              <div className="space-y-3 mb-4">
                {[
                  {
                    id: 'archive',
                    icon: HardDrive,
                    label: t('common.archive'),
                    description: t('bulk.ops.copyIntoVaultStaysServer'),
                  },
                  ...(hasArchivedSelected ? [{
                    id: 'unarchive',
                    icon: ArchiveRestore,
                    label: t('rowMenu.unarchive'),
                    description: t('bulk.ops.deleteVaultCopyServerCopy'),
                  }] : []),
                  {
                    id: 'delete',
                    icon: Trash2,
                    label: t('bulk.ops.deleteServer'),
                    description: deleteDescription,
                  },
                  {
                    id: 'archive_and_delete',
                    icon: Archive,
                    label: t('bulk.ops.archiveDelete'),
                    description: t('bulk.ops.copyIntoVaultVerifyEach'),
                  },
                  {
                    id: 'delete_everywhere',
                    icon: Trash2,
                    label: t('bulk.ops.deleteEverywhere'),
                    description: t('bulk.ops.removeServerVaultBackupDrive'),
                  },
                ].map(action => {
                  const isActive = selectedAction === action.id;
                  const Icon = action.icon;
                  const styles = ACTION_STYLES()[action.id];
                  const isGradient = action.id === 'archive_and_delete';
                  return (
                    <button
                      key={action.id}
                      data-testid={`bulk-action-${action.id}`}
                      onClick={() => setSelectedAction(action.id)}
                      className={`w-full flex items-center gap-3 p-3 rounded-lg border transition-all text-left ${
                        isActive ? '' : 'bg-mail-surface border-mail-border hover:bg-mail-surface-hover'
                      }`}
                      style={isActive ? {
                        background: isGradient
                          ? actionBg('var(--mail-local)', 10)
                          : actionBg(styles.color, 10),
                        borderColor: isGradient
                          ? actionBg('var(--mail-danger)', 30)
                          : actionBg(styles.color, 30),
                      } : undefined}
                    >
                      <div
                        className="w-8 h-8 rounded-lg flex items-center justify-center"
                        style={isActive ? {
                          background: isGradient
                            ? actionBg('var(--mail-local)', 20)
                            : actionBg(styles.color, 20),
                        } : { backgroundColor: 'var(--mail-border)' }}
                      >
                        <Icon size={16} className={isActive ? styles.iconColor : 'text-mail-text-muted'} />
                      </div>
                      <div>
                        <div className="text-sm font-medium text-mail-text">
                          {action.label}
                        </div>
                        <div className="text-xs text-mail-text-muted">{action.description}</div>
                      </div>
                    </button>
                  );
                })}
              </div>

              {/* Footer */}
              <div className="flex justify-between pt-3 border-t border-mail-border">
                <button
                  onClick={() => { setStep(1); setSelectedAction(null); }}
                  className="flex items-center gap-1.5 px-4 py-2 text-sm text-mail-text-muted
                            hover:bg-mail-border rounded-lg transition-colors"
                >
                  <ArrowLeft size={14} />
                  {t('common.back')}
                </button>
                <button
                  onClick={handleConfirm}
                  disabled={!selectedAction}
                  data-testid="bulk-step2-confirm"
                  className="px-4 py-2 text-sm font-medium text-white rounded-lg transition-all
                            disabled:opacity-50 disabled:cursor-not-allowed hover:opacity-90"
                  style={{
                    background: !selectedAction || selectedAction === 'archive_and_delete'
                      ? 'var(--mail-accent)'
                      : ACTION_STYLES()[selectedAction].color
                  }}
                >
                  {selectedAction ? ACTION_STYLES()[selectedAction].confirmLabel : t('bulk.ops.start')}
                </button>
              </div>
            </div>
          )}
    </Dialog>
  );
}
