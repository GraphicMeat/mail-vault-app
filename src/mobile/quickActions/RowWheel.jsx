// The wheel a long press opens on a list row: desktop's own wheel (QuickActionsWheel.jsx, the
// stylesheet, the sizes, the centre label) at the finger, configured from the phone's `quickActions`
// pref (config.js, desktop's shape and scopes) and run through the app's own paths (the same ones
// a swipe takes: confirmation, undo, the folder picker). The phone's Select wedge joins it at the
// end, not saved. What each of desktop's actions is on the phone: actionTable.js.
//
// Touch: the press that opened the wheel is still down, so its pointer events keep arriving at the
// row. They are taken here (stopped before the row's swipe sees them) to follow the finger over the
// wedges (touch.js): one haptic tick per wedge changed, the wedge lights, and lifting on one runs
// it. Lifting anywhere else leaves the wheel open for taps, and the click that follows the lift
// is the hold's, not a tap on the row. While the finger is down the list neither scrolls nor
// swipes (the one non-passive touchmove in the phone; `mv-wheel-open` also stops the scroller).
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { QuickActionsConfigured } from '../../components/QuickActionsWheel.jsx';
import { SettingsViewProvider } from '../../components/settings/views/viewContext.jsx';
import { haptic } from '../haptics.js';
import { useMobileStore } from '../store.js';
import { useT, getMobileLocale } from '../i18n.js';
import { daemonCall } from '../transport.js';
import { ensureTags, useTagStore } from '../tags.js';
import { ALL_INBOXES } from '../folders.js';
import { junkFolder } from '../quickActions.js';
import { rowUids } from '../prefs.js';
import { phoneScope, phoneSurface } from './config.js';
import { SELECT_ENTRY, buildDescriptors, phoneFacts } from './descriptors.js';
import { hotWedge, shadowNextRowClick, wedgeAt } from './touch.js';

const EMPTY = Object.freeze([]);

/** A conversation's row reads as its messages do: unread while any is, flagged while any is. */
export const shownRow = (row) => (row.threadCount > 1
  ? { ...row, seen: row.seen && !(row.threadUnread > 0), flagged: row.flagged || row.threadFlagged === true }
  : row);

/** The configured row entries: desktop's reader-only tools out, a saved move's desktop account out, Select last. */
export function wheelConfig(config, withSelect = true) {
  const entries = config.entries.filter((e) => !['source', 'theme'].includes(e.action));
  return { ...config, entries: withSelect ? [...entries, SELECT_ENTRY] : entries };
}

/** Follows the finger that is still down over the open wheel; see the header. */
function useFinger(active) {
  useEffect(() => {
    if (!active) return undefined;
    let hot = null;
    let down = true;
    const root = document.documentElement;
    root.classList.add('mv-wheel-open');
    const move = (e) => {
      if (!down || !e.isPrimary) return;
      e.stopPropagation();
      const next = wedgeAt(e.clientX, e.clientY);
      if (next !== hot) {
        hot = hotWedge(hot, next);
        if (hot) haptic.selection();
      }
    };
    const up = (e) => {
      if (!down || !e.isPrimary) return;
      down = false;
      e.stopPropagation();
      shadowNextRowClick();
      const el = hot;
      hot = hotWedge(hot, null);
      if (el) el.click();
    };
    const cancel = (e) => {
      if (!down || !e.isPrimary) return;
      down = false;
      shadowNextRowClick();
      hot = hotWedge(hot, null);
    };
    const touch = (e) => { if (down && e.cancelable) e.preventDefault(); };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', cancel, true);
    document.addEventListener('touchmove', touch, { passive: false });
    return () => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', cancel, true);
      document.removeEventListener('touchmove', touch);
      root.classList.remove('mv-wheel-open');
      hotWedge(hot, null);
    };
  }, [active]);
}

function Wheel({ target, onClose, onAction, onMove, onCompose, onSelect }) {
  const t = useT();
  const { row } = target;
  const prefs = useMobileStore((s) => s.prefs);
  const activeAccountId = useMobileStore((s) => s.activeAccountId);
  const activeFolder = useMobileStore((s) => s.activeFolder);
  const activeFolders = useMobileStore((s) => s.folders);
  const labels = useTagStore((s) => s.tags);
  const place = useMemo(() => useMobileStore.getState().placeOf(row), [row]);
  const [otherFolders, setOtherFolders] = useState(null);
  const folders = place.accountId === activeAccountId ? activeFolders : otherFolders;
  useEffect(() => { ensureTags(); }, []);
  useEffect(() => {
    if (place.accountId === activeAccountId || !place.accountId) return undefined;
    let live = true;
    daemonCall('mobile.folders.list', { accountId: place.accountId }).then(
      (reply) => { if (live) setOtherFolders(reply?.folders ?? []); },
      () => { if (live) setOtherFolders([]); },
    );
    return () => { live = false; };
  }, [place.accountId, activeAccountId]);
  useFinger(true);

  const scope = useMemo(
    () => phoneScope({ accountId: place.accountId, folder: place.folder, allInboxes: activeFolder === ALL_INBOXES }),
    [place.accountId, place.folder, activeFolder],
  );
  const config = useMemo(() => wheelConfig(phoneSurface(prefs, 'row', scope), Boolean(onSelect)), [prefs, scope, onSelect]);
  const shown = useMemo(() => shownRow(row), [row]);
  const junk = junkFolder(folders || EMPTY);
  const junkPath = junk && junk.path !== place.folder ? junk.path : null;
  const facts = useMemo(
    () => phoneFacts([shown], { accountId: place.accountId, mailbox: place.folder, junkPath }),
    [shown, place.accountId, place.folder, junkPath],
  );
  const handlers = {
    setRead: (read) => onAction(read ? 'seen' : 'unseen', shown),
    setFlagged: (flagged) => onAction(flagged ? 'flag' : 'unflag', shown),
    delete: () => onAction('delete', shown),
    pickFolder: () => onAction('move', shown),
    moveTo: (path) => onMove(shown, path),
    spam: () => junkPath && onMove(shown, junkPath),
    tag: (tagId) => useTagStore.getState().setOnRows(
      rowUids(row).map((uid) => ({ accountId: place.accountId, folder: place.folder, uid })), tagId, true,
    ),
    compose: (mode) => onCompose(mode, shown),
    select: () => onSelect?.(shown),
  };
  const descriptors = buildDescriptors({
    surface: 'row', entries: config.entries, facts, handlers,
    ctx: { tags: labels || EMPTY, folders: () => folders || EMPTY },
  });
  // A new object each time: the wheel opens at the point only when it changes.
  const openAt = useMemo(() => ({ x: target.x, y: target.y }), [target]);
  return (
    <SettingsViewProvider t={t} locale={getMobileLocale()}>
      <div hidden data-mv-wheel-host>
        <QuickActionsConfigured
          surface="row"
          config={config}
          descriptors={descriptors}
          identity={target.key}
          openAt={openAt}
          forceRadial
          onOpenChange={(open) => { if (!open) onClose(); }}
        />
      </div>
    </SettingsViewProvider>
  );
}

/** `target`: `{ row, key, x, y }` while the wheel is open (a long press's point), else null. */
export default function RowWheel({ target, ...rest }) {
  return target ? <Wheel key={target.key} target={target} {...rest} /> : null;
}
