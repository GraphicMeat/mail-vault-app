// ── the once-a-day reminder of server actions still owed ──
//
// A delete the server refuses stays queued and keeps being retried with no
// limit (replayOps), so nothing is said when it fails. What the user is told
// is this: once a day at most, after a replay that still keeps entries while
// online, one modal with the count and a link to Settings › Unfinished server
// actions. Offline is not a failure worth a reminder; the queue waits for the
// link and the reconnect replay sends it.

import { useSettingsStore } from '../../stores/settingsStore';
import { useConnectivityStore } from '../../stores/connectivityStore';

export const REMIND_EVERY_MS = 24 * 60 * 60 * 1000;

/** Raise the reminder for `kept` owed messages when a day has passed. */
export async function remindOfUnfinished(kept, now = Date.now()) {
  if (!kept || !useConnectivityStore.getState().online) return false;
  const settings = useSettingsStore.getState();
  if (now - (settings.pendingActionsRemindedAt || 0) < REMIND_EVERY_MS) return false;
  settings.markPendingActionsReminded(now);
  const { useMailStore } = await import('../../stores/mailStore');
  useMailStore.setState({ pendingActionsReminder: { count: kept } });
  return true;
}
