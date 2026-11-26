// The bar under a selecting list: desktop's selection surface, inline (SelectionBarFrame.jsx, the
// wheel file's `QuickActionsConfigured` with `surface="selection"`, the same configuration the
// person edits in Settings > Quick actions > Selection), over the ticked rows. Every action is one
// engine call per place the ticked rows live in (store.actMany), not one per row: read, star, a
// move to a folder or to Junk, delete (which asks once with the count, then has its undo toast),
// and a label. When an action is done the haptics say success; a delete, a move or a move to Junk
// then leaves selecting, a read or a star keeps the ticks (their rows read as they now are).
import React, { useEffect, useMemo, useState } from 'react';
import { QuickActionsConfigured } from '../../components/QuickActionsWheel.jsx';
import { SelectionBarFrame } from '../../components/SelectionBarFrame.jsx';
import { SettingsViewProvider } from '../../components/settings/views/viewContext.jsx';
import { haptic } from '../haptics.js';
import { INBOX, useMobileStore } from '../store.js';
import { useT, getMobileLocale } from '../i18n.js';
import { daemonCall } from '../transport.js';
import { ensureTags, useTagStore } from '../tags.js';
import { ALL_INBOXES } from '../folders.js';
import { junkFolder } from '../quickActions.js';
import MovePicker from '../MovePicker.jsx';
import { useBackLayer } from '../backStack.js';
import { phoneScope, phoneSurface } from '../quickActions/config.js';
import { buildDescriptors, phoneFacts } from '../quickActions/descriptors.js';
import { shownRow } from '../quickActions/RowWheel.jsx';
import { bulkCount, bulkGroups, useSelection } from './selectionStore.js';

const EMPTY = Object.freeze([]);

/** The selection surface's entries, without the reader-only tools (a saved configuration may name any). */
export function barConfig(config) {
  return { ...config, entries: config.entries.filter((e) => !['source', 'theme'].includes(e.action)) };
}

/** `confirm(count, run)` asks once before a delete; the app's own sheet (App.jsx `askDelete`). */
export default function SelectionBar({ confirm }) {
  const t = useT();
  const items = useSelection((s) => s.items);
  const prefs = useMobileStore((s) => s.prefs);
  const activeAccountId = useMobileStore((s) => s.activeAccountId);
  const activeFolder = useMobileStore((s) => s.activeFolder);
  const activeFolders = useMobileStore((s) => s.folders);
  const labels = useTagStore((s) => s.tags);
  const [picking, setPicking] = useState(false);
  const closePicker = () => setPicking(false);
  useBackLayer(picking, closePicker);
  useEffect(() => { ensureTags(); }, []);

  const entries = useMemo(() => [...items.values()], [items]);
  const rows = useMemo(() => entries.map((e) => shownRow(e.row)), [entries]);
  const accountIds = [...new Set(entries.map((e) => e.place.accountId))];
  const folderPaths = [...new Set(entries.map((e) => e.place.folder))];
  const accountId = accountIds.length === 1 ? accountIds[0] : null;
  const folder = folderPaths.length === 1 ? folderPaths[0] : null;
  // The folders of the one account the ticks are in: the open one's, else read.
  const [otherFolders, setOtherFolders] = useState(null);
  const folders = accountId === activeAccountId ? activeFolders : otherFolders;
  useEffect(() => {
    setOtherFolders(null);
    if (!accountId || accountId === activeAccountId) return undefined;
    let live = true;
    daemonCall('mobile.folders.list', { accountId }).then(
      (reply) => { if (live) setOtherFolders(reply?.folders ?? []); },
      () => { if (live) setOtherFolders([]); },
    );
    return () => { live = false; };
  }, [accountId, activeAccountId]);

  const scope = useMemo(
    () => phoneScope({ accountId: activeAccountId, folder: activeFolder === ALL_INBOXES ? INBOX : activeFolder, allInboxes: activeFolder === ALL_INBOXES }),
    [activeAccountId, activeFolder],
  );
  const config = useMemo(() => barConfig(phoneSurface(prefs, 'selection', scope)), [prefs, scope]);
  const junk = junkFolder(folders || EMPTY);
  const junkPath = junk && folderPaths.every((f) => f !== junk.path) ? junk.path : null;
  const facts = useMemo(() => phoneFacts(rows, { accountId, mailbox: folder, junkPath }), [rows, accountId, folder, junkPath]);

  const done = (leave) => {
    haptic.notify('success');
    if (leave) useSelection.getState().end();
  };
  const act = (kind, groups, opts) => {
    if (!groups.length) return;
    useMobileStore.getState().actMany(kind, groups, opts);
  };
  const setRead = (read) => {
    act(read ? 'seen' : 'unseen', bulkGroups(items, (row) => shownRow(row).seen !== read));
    useSelection.getState().patch((row) => (row.threadCount > 1
      ? { ...row, seen: read, threadUnread: read ? 0 : Math.max(1, row.threadUnread || 0) }
      : { ...row, seen: read }));
    done(false);
  };
  const setFlagged = (flagged) => {
    act(flagged ? 'flag' : 'unflag', bulkGroups(items, (row) => shownRow(row).flagged !== flagged));
    useSelection.getState().patch((row) => (row.threadCount > 1
      ? { ...row, flagged, threadFlagged: flagged }
      : { ...row, flagged }));
    done(false);
  };
  const moveTo = (target) => {
    act('move', bulkGroups(items), { target });
    done(true);
  };
  const handlers = {
    setRead,
    setFlagged,
    delete: () => {
      const groups = bulkGroups(items);
      confirm(bulkCount(groups), () => {
        act('delete', groups);
        done(true);
      });
    },
    pickFolder: () => setPicking(true),
    moveTo,
    spam: () => junkPath && moveTo(junkPath),
    tag: (tagId) => {
      useTagStore.getState().setOnRows(
        bulkGroups(items).flatMap((g) => g.uids.map((uid) => ({ accountId: g.accountId, folder: g.folder, uid }))), tagId, true,
      );
      done(false);
    },
  };
  const descriptors = buildDescriptors({
    surface: 'selection', entries: config.entries, facts, handlers,
    ctx: { tags: labels || EMPTY, folders: () => folders || EMPTY },
  });
  if (!entries.length) return null;
  const display = config.selectionDisplay || 'icon-label';
  return (
    <SettingsViewProvider t={t} locale={getMobileLocale()}>
      <div className="mv-selbar" data-mv-selbar>
        <SelectionBarFrame
          label={t('common.selectedCount', { count: entries.length })}
          clearTitle={t('selection.clearSelection')}
          onClear={() => useSelection.getState().end()}
        >
          <QuickActionsConfigured
            surface="selection"
            config={config}
            descriptors={descriptors}
            display={display}
            inlineLimit={display === 'icon-only' ? undefined : config.selectionActionLimit || 3}
            className="quick-actions-selection min-w-0"
            identity={entries.map((e) => e.row.uid).join('|')}
            forceRadial
          />
        </SelectionBarFrame>
      </div>
      {picking && (
        <MovePicker
          folders={folders || EMPTY}
          current={folder}
          onPick={(target) => { setPicking(false); moveTo(target); }}
          onClose={closePicker}
        />
      )}
    </SettingsViewProvider>
  );
}
