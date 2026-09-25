// A row's quick actions, reachable from outside the row. RowQuickActions
// registers its descriptor builder on a hidden marker inside the row, and a
// trackpad swipe runs an action through it by id: the same handler, disabled
// check and follow-up UI (move dropdown, snooze picker) as clicking it.

const registry = new WeakMap();

/** Ref callback target: `node` is the row's `[data-row-actions]` marker. */
export function registerRowActions(node, describeRef) {
  if (node) registry.set(node, describeRef);
}

/**
 * Run the first of `actions` the row allows. `anchor` is what a follow-up
 * popover is placed against. Returns whether anything ran.
 */
export function runRowQuickAction(row, actions, anchor = row) {
  const describe = registry.get(row?.querySelector('[data-row-actions]'))?.current;
  if (!describe) return false;
  for (const action of actions) {
    const descriptor = describe({ id: action, action });
    if (!descriptor || descriptor.disabled || descriptor.hidden) continue;
    Promise.resolve(descriptor.onActivate?.({ currentTarget: anchor, stopPropagation() {}, preventDefault() {} }))
      .catch(error => console.error(`[swipe] ${action} failed:`, error));
    return true;
  }
  return false;
}
