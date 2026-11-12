import { useCallback, useState } from 'react';

// Increment at the setter boundary, before React commits or autosave publishes.
export function useSendState(initial, invalidate) {
  const [value, setValue] = useState(initial);
  const change = useCallback(next => { invalidate(); setValue(next); }, [invalidate]);
  return [value, change];
}
