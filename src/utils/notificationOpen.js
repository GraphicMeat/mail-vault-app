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
  let active = true;
  let unlisten = null;

  const drain = async () => {
    const target = await invoke('take_notification_open');
    if (target && active) await open(target);
  };

  const ready = listen('notification-open', drain)
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
