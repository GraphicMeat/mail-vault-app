/**
 * Driving a message row's own actions menu.
 *
 * The row's 3-dot "Row actions" menu is gone: a row now carries a
 * user-configurable QuickActions set (RowQuickActions), and by default that
 * is a radial wheel behind one `.quick-actions-trigger` ("Quick actions").
 * The wheel's wedges are icon-only — their text is empty and the label lives
 * in `aria-label` — so a spec that clicked `[role="menuitem"]` by its text
 * found nothing, and one that looked for `button[aria-label="Row actions"]`
 * never opened a menu at all.
 *
 * The harness seeds the row as `favorite-menu` (wdio.conf.js): the favourite
 * (Archive) is a button on the row itself and everything else sits in a list
 * menu behind the trigger. So "what the row offers" is both.
 *
 * Address the row's trigger and the action instead: the trigger inside the
 * row's `.quick-actions[data-surface="row"]`, the open panel as
 * `[role="menu"][data-surface="row"]` (so the reader's or the selection
 * bar's menu can never answer for it), and each item by `data-quick-action`,
 * in that panel or inline on the row whose trigger opened it. That works
 * whichever layout the row is configured with.
 *
 * Plain data crosses into the page, never a function: the app's CSP has no
 * `unsafe-eval`, so a rebuilt callback is refused.
 */

const MENU = '[role="menu"][data-surface="row"]';

export const rowMenuIsOpen = () =>
  browser.execute((sel) => !!document.querySelector(sel), MENU);

/**
 * Click the trigger of the first visible row that matches, and say which row
 * that was. `match` is one of:
 *   { index }            the nth visible row
 *   { text, not? }       the first row whose text holds every string in `text`
 *                        (a string or an array) and none in `not`
 *   { withinOfBottom }   the lowest row whose bottom edge is inside the window
 *                        and within that many px of its bottom
 * Returns null when no row matched or it has no trigger.
 */
export const clickRowMenuTrigger = (match) => browser.execute((m) => {
  const rows = [...document.querySelectorAll('[data-testid="email-row"]')].filter(r => r.offsetHeight > 0);
  let row = null;
  if (typeof m.index === 'number') row = rows[m.index];
  else if (m.withinOfBottom) {
    const inside = rows.filter(r => r.getBoundingClientRect().bottom <= window.innerHeight);
    const last = inside[inside.length - 1];
    if (last && last.getBoundingClientRect().bottom > window.innerHeight - m.withinOfBottom) row = last;
  } else {
    const want = [].concat(m.text || []);
    const not = [].concat(m.not || []);
    row = rows.find(r => {
      const text = r.textContent || '';
      return want.every(s => text.includes(s)) && !not.some(s => text.includes(s));
    });
  }
  const btn = row?.querySelector('.quick-actions[data-surface="row"] .quick-actions-trigger');
  if (!btn) return null;
  const rect = row.getBoundingClientRect();
  btn.click();
  return { top: rect.top, bottom: rect.bottom, text: (row.textContent || '').trim().slice(0, 60) };
}, match);

/**
 * Open the matching row's menu, whatever state it is in. The trigger TOGGLES,
 * so one more click on an open menu shuts it: ask for the end state, not the
 * click. Resolves to the row `clickRowMenuTrigger` reported (or true when the
 * menu was already open).
 */
export async function openRowMenu(match, why = `the row menu never opened for ${JSON.stringify(match)}`, timeout = 30_000) {
  let row = true;
  await browser.waitUntil(async () => {
    if (await rowMenuIsOpen()) return true;
    row = await clickRowMenuTrigger(match) || row;
    await browser.pause(250);
    return rowMenuIsOpen();
  }, { timeout, interval: 300, timeoutMsg: why });
  return row;
}

/**
 * Every action the row with the open menu offers — inline on the row, then in
 * the menu — with its label and whether it is usable.
 */
export const rowMenuItems = () => browser.execute((sel) => {
  const trigger = document.querySelector('.quick-actions[data-surface="row"] .quick-actions-trigger[aria-expanded="true"]');
  const inline = trigger?.closest('.quick-actions')?.querySelectorAll(':scope > [data-quick-action]') || [];
  const menu = document.querySelector(sel)?.querySelectorAll('[data-quick-action]') || [];
  return [...inline, ...menu].map(el => ({
    action: el.dataset.quickAction,
    label: el.getAttribute('aria-label') || (el.textContent || '').trim(),
    disabled: el.disabled,
  }));
}, MENU);

/**
 * Click an action the row with the open menu offers (in the menu or inline
 * on that row) by its QUICK_ACTION_TYPES name
 * ('archive', 'unarchive', 'move', 'deleteServer', 'deleteEverywhere',
 * 'reply', 'newMessage', ...). False — not a throw — when the menu does not
 * offer it or it is greyed out, so specs can `expect(...).toBe(true)`.
 *
 * Activation closes the menu, but AnimatePresence keeps the panel and its
 * full-screen backdrop mounted through the exit animation, and whatever the
 * action opened (the folder list, a confirmation) sits under that backdrop
 * until it goes. Hand the caller a settled page.
 */
export async function clickRowAction(action) {
  const clicked = await browser.execute((sel, wanted) => {
    const trigger = document.querySelector('.quick-actions[data-surface="row"] .quick-actions-trigger[aria-expanded="true"]');
    const btn = document.querySelector(`${sel} [data-quick-action="${wanted}"]`)
      || trigger?.closest('.quick-actions')?.querySelector(`:scope > [data-quick-action="${wanted}"]`);
    if (!btn || btn.disabled) return false;
    btn.click();
    return true;
  }, MENU, action);
  if (clicked) {
    await browser.waitUntil(() => browser.execute((sel) => !document.querySelector(sel), MENU),
      { timeout: 5_000, interval: 50 }).catch(() => {});
  }
  return clicked;
}

/** Shut the row menu through its backdrop, the one element wired to onClose. */
export async function closeRowMenu() {
  await browser.execute((sel) => document.querySelector(sel)?.previousElementSibling?.click(), MENU);
  await browser.waitUntil(() => browser.execute((sel) => !document.querySelector(sel), MENU),
    { timeout: 5_000, interval: 50 }).catch(() => {});
}
