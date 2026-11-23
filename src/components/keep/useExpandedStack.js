import { useEffect, useState } from 'react';

/**
 * The key of the stack whose panel the app holds open. A stack that is gone (its last email removed,
 * its account dropped) is never open, and does not come back open when a new email brings it back.
 */
export function useExpandedStack(stacks) {
  const [key, setKey] = useState(null);
  const live = stacks.some(stack => stack.key === key) ? key : null;
  useEffect(() => { if (key !== null && live === null) setKey(null); }, [key, live]);
  return [live, setKey];
}
