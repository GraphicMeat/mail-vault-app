import { fireEvent, screen } from '@testing-library/react';

/**
 * Pick `value` in the EmailSelector whose trigger carries `testId`, the way a
 * person does: open it, click the row. Values are opaque (Compose's carry a
 * space), so the row is found by its data-value, never by a built testid.
 */
export function pickEmail(testId, value, root = document) {
  const trigger = root === document ? screen.getByTestId(testId) : root.querySelector(`[data-testid="${testId}"]`);
  if (trigger.getAttribute('aria-expanded') !== 'true') fireEvent.click(trigger);
  const row = [...document.querySelectorAll(`[data-email-selector-list="${testId}"] [role="option"]`)]
    .find(node => node.dataset.value === value);
  if (!row) throw new Error(`EmailSelector ${testId} has no row "${value}"`);
  fireEvent.click(row);
}

/** The rows an EmailSelector lists, as their visible text (name and address, not the avatar), opening it first. */
export function emailRows(testId) {
  const trigger = screen.getByTestId(testId);
  if (trigger.getAttribute('aria-expanded') !== 'true') fireEvent.click(trigger);
  return [...document.querySelectorAll(`[data-email-selector-list="${testId}"] [role="option"]`)]
    .map(node => ({ value: node.dataset.value, text: (node.querySelector('.email-selector-text')?.textContent ?? node.textContent).trim() }));
}
