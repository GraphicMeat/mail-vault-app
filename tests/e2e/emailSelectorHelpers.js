// Drive an EmailSelector (src/components/ui/EmailSelector.jsx) the way a person
// does: open it, click the row. Rows carry their opaque value in data-value.
//
// React renders the opened panel after the click's script returns (a
// microtask), so opening and reading the rows are separate steps: open, wait
// for the list, then act on it.

/** In-page: open the selector at `sel` if it is closed. False when it is missing or disabled. */
function openInPage(sel) {
  const trigger = document.querySelector(sel);
  if (!trigger || trigger.disabled) return false;
  if (trigger.getAttribute('aria-expanded') !== 'true') trigger.click();
  return true;
}

/** In-page: close the selector at `sel` if it is open. */
function closeInPage(sel) {
  const trigger = document.querySelector(sel);
  if (trigger?.getAttribute('aria-expanded') === 'true') trigger.click();
}

async function openAndWait(sel) {
  if (!(await browser.execute(openInPage, sel))) return false;
  try {
    await browser.waitUntil(() => browser.execute((s) => {
      const trigger = document.querySelector(s);
      return trigger?.getAttribute('aria-expanded') === 'true'
        && !!document.querySelector(`[data-email-selector-list="${trigger.dataset.testid}"]`);
    }, sel), { timeout: 3000, interval: 50 });
    return true;
  } catch {
    return false;
  }
}

/** Pick `value` in the selector at `sel`. False when the selector or the row is missing. */
export async function pickEmail(sel, value) {
  if (!(await openAndWait(sel))) return false;
  const ok = await browser.execute((s, v) => {
    const trigger = document.querySelector(s);
    const list = document.querySelector(`[data-email-selector-list="${trigger?.dataset.testid}"]`);
    const row = list && [...list.querySelectorAll('[role="option"]')].find(node => node.dataset.value === v);
    if (!row) return false;
    row.click();
    return true;
  }, sel, String(value));
  if (!ok) await browser.execute(closeInPage, sel);
  await browser.pause(150);
  return ok;
}

/** Every row as { value, address, text, kind, selected }; closes the panel again if it opened it. */
export async function emailRows(sel) {
  const wasOpen = await browser.execute(s => document.querySelector(s)?.getAttribute('aria-expanded') === 'true', sel);
  if (!(await openAndWait(sel))) return null;
  const rows = await browser.execute((s) => {
    const trigger = document.querySelector(s);
    const list = document.querySelector(`[data-email-selector-list="${trigger?.dataset.testid}"]`);
    return [...(list?.querySelectorAll('[role="option"]') || [])].map(node => ({
      value: node.dataset.value, address: node.dataset.address || '',
      text: (node.querySelector('.email-selector-text')?.textContent ?? node.textContent).trim(),
      kind: node.dataset.kind, selected: node.getAttribute('aria-selected') === 'true',
    }));
  }, sel);
  if (!wasOpen) {
    await browser.execute(closeInPage, sel);
    await browser.pause(100);
  }
  return rows;
}

export const isEmailSelector = (sel) => browser.execute(s => !!document.querySelector(s)?.hasAttribute('data-email-selector'), sel);
