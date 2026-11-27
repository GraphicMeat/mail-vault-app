import { useMemo } from 'react';
import { useViewStore } from '../../stores/viewStore';

// The list toolbar's select-all over the rows a search or a saved view shows.
// A saved view renders its newest 500 rows, but select-all means every
// message it finds (its badge): the view store asks the daemon for them all,
// and a view that cannot answer falls back to the rows on screen. A view
// selected whole holds more keys than it renders and still reads as "all
// selected", so the next click clears it.
export function useSelectAll({ displayEmails, selectedEmailIds, activeViewId, selKey, setEmailsSelected }) {
  const allSelected = useMemo(() => {
    if (!displayEmails.length || selectedEmailIds.size < displayEmails.length) return false;
    if (selectedEmailIds.size === displayEmails.length) return true;
    return !!activeViewId && displayEmails.every(email => selectedEmailIds.has(selKey(email)));
  }, [displayEmails, selectedEmailIds, activeViewId, selKey]);

  const selectAllShown = () => {
    if (!activeViewId) return setEmailsSelected(displayEmails, true);
    return useViewStore.getState().selectAllInView().then(count => {
      if (count == null) setEmailsSelected(displayEmails, true);
    });
  };

  return { allSelected, selectAllShown };
}
