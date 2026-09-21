/**
 * Clicking an action on the SelectionActionBar.
 *
 * The bar's actions are a user-configurable QuickActions set. The default
 * files three of the eight inline and puts the rest behind the overflow
 * trigger, whose menu is `{open && ...}` — so a button like "Delete from
 * server" is not in the DOM at all until the trigger is clicked, and which
 * verbs are buttons at all changes with the configuration. Specs that reached
 * for `button[title="..."]` were therefore asserting on one layout, not on the
 * action, and the titles are shared with the row's own hover buttons anyway.
 *
 * Address the action instead: `data-quick-action` on the button, scoped to
 * `data-surface="selection"` so a row's Archive can never answer for the
 * bar's. Open the overflow menu only when the action is not already inline.
 */

/** One pass: click it inline, click it in the open menu, or open the menu. */
const attempt = (action) =>
  browser.execute((wanted) => {
    const usable = (btn) => !!btn && btn.offsetHeight > 0 && !btn.disabled;
    const bar = document.querySelector('[data-testid="selection-action-bar"]');
    if (!bar) return 'no-bar';
    const menu = document.querySelector('[data-surface="selection"].quick-actions-menu');
    const inline = bar.querySelector(`[data-quick-action="${wanted}"]`);
    const buried = menu && menu.querySelector(`[data-quick-action="${wanted}"]`);
    const target = usable(inline) ? inline : usable(buried) ? buried : null;
    if (target) {
      target.click();
      return 'clicked';
    }
    // Present but greyed out is a real answer about the selection, not a
    // reason to go hunting in the menu for a second copy of the same button.
    if (inline || buried) return 'disabled';
    if (menu) return 'missing';
    const trigger = bar.querySelector('.quick-actions-trigger');
    if (!usable(trigger)) return 'missing';
    trigger.click();
    return 'opened';
  }, action);

/**
 * @param {string} action A QUICK_ACTION_TYPES name: 'archive', 'unarchive',
 *   'markRead', 'markUnread', 'move', 'deleteServer', 'deleteEverywhere',
 *   'export'.
 * @returns {Promise<boolean>} whether the click landed — false, not a throw,
 *   so the existing `waitUntil(() => clickSelectionAction(...))` shape works.
 */
export async function clickSelectionAction(action) {
  let outcome = await attempt(action);
  if (outcome === 'opened') outcome = await attempt(action);
  if (outcome === 'clicked') {
    // An action activated from inside the menu closes it, but AnimatePresence
    // keeps the panel AND its full-screen backdrop mounted through the exit
    // animation — and anything the action just opened (the move dropdown, a
    // confirmation) sits under that backdrop until it goes. Hand the caller a
    // settled page instead of a 200ms window where nothing takes a click.
    await browser.waitUntil(
      () => browser.execute(() =>
        !document.querySelector('[data-surface="selection"].quick-actions-menu')),
      { timeout: 5_000, interval: 50 },
    ).catch(() => {});
    return true;
  }
  // Leaving the overflow menu open would swallow the next click on the list.
  // The panel's own backdrop is the one element whose click is wired to
  // onClose, and a retry has to find the menu shut or it can never reopen it.
  await browser.execute(() => {
    document.querySelector('[data-surface="selection"].quick-actions-menu')
      ?.previousElementSibling?.click();
  });
  return false;
}

/** Is the bar on screen with this action available? Clicks nothing. */
export const selectionActionReady = (action) =>
  browser.execute((wanted) => {
    const bar = document.querySelector('[data-testid="selection-action-bar"]');
    if (!bar) return false;
    const btn = bar.querySelector(`[data-quick-action="${wanted}"]`)
      || bar.querySelector('.quick-actions-trigger');
    return !!btn && btn.offsetHeight > 0;
  }, action);

/** Is the selection bar gone? The inverse assertion several specs make. */
export const selectionBarGone = () =>
  browser.execute(() =>
    document.querySelector('[data-testid="selection-action-bar"]') === null);

/**
 * The bar's confirmation dialog. Bulk unarchive and every delete route through
 * it — unarchive included, since it removes the vault copy. `role`, not a
 * title: the confirm button's label changes with which action asked.
 */
export const confirmSelectionDialog = () =>
  browser.execute(() => {
    const dialog = document.querySelector('[role="alertdialog"]');
    const buttons = dialog ? [...dialog.querySelectorAll('button')] : [];
    const confirm = buttons[buttons.length - 1];
    if (!confirm || confirm.offsetHeight === 0) return false;
    confirm.click();
    return true;
  });
