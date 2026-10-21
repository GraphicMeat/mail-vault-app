/**
 * Clicking a new-mail banner opens the message it announced, in the folder it
 * arrived in.
 *
 * Same shape as the mailto bridge: Rust queues the clicked target
 * (`notification_open.rs`) and the event is only a wake-up, because a click on
 * a banner left in Notification Center after quitting launches the app before
 * this webview exists. Start it once accounts are in the store, or that first
 * drain has nothing to open the target in.
 */
export function startNotificationOpenBridge({ invoke, listen, open }) {
  return bridge(listen, 'notification-open', async (isActive) => {
    const target = await invoke('take_notification_open');
    if (target && isActive()) await open(target);
  });
}

/**
 * Delete and Copy & delete on a one-time-code banner (macOS): Rust has copied
 * the code and queued the message; each queued one is deleted the way the
 * code bubble deletes it. Same queue-plus-wake-up shape as the click, for a
 * press that launched the app.
 */
export function startNotificationDeleteBridge({ invoke, listen, remove }) {
  return bridge(listen, 'notification-delete', async (isActive) => {
    for (const target of (await invoke('take_notification_deletes')) || []) {
      if (!isActive()) return;
      try {
        await remove(target);
      } catch (e) {
        console.warn('[notification] could not delete the email:', e);
      }
    }
  });
}

function bridge(listen, event, drainWith) {
  let active = true;
  let unlisten = null;
  const drain = () => drainWith(() => active);

  const ready = listen(event, drain)
    .then(fn => {
      if (!active) fn();
      else unlisten = fn;
    })
    .then(() => (active ? drain() : undefined));

  return {
    ready,
    stop: () => { active = false; if (unlisten) unlisten(); },
  };
}

/**
 * Switches only when the folder is not already the plain view on screen: a
 * reactivation of the open folder would wipe the list the message is in.
 * An account removed since the banner fired opens nothing.
 */
export async function openNotificationTarget({ accountId, mailbox, uid }, getState) {
  const state = getState();
  if (!state.accounts?.some(a => a.id === accountId)) return;
  const onScreen = state.activeAccountId === accountId && state.activeMailbox === mailbox
    && !state.unifiedInbox && !state.mailboxScope;
  if (!onScreen) await state.activateAccount(accountId, mailbox);
  if (uid != null) await getState().selectEmail(uid);
}
