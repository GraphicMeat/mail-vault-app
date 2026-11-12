import { useEffect } from 'react';
import { useScheduledStore } from '../../stores/scheduledStore';

export function useScheduleZoneSuggestion({ schedulePremium, suggestAddress, scheduleDraft, editingScheduled, setScheduleDraft, setTzSuggestion, suggestName }) {
  // Preselect the recipient's zone when the schedule panel opens, and again
  // if the first To address changes while it is open. Never over a zone
  // picked by hand, and never on an edit of a scheduled email, whose own
  // zone is the answer. The panel does not wait for the daemon.

  useEffect(() => {
    if (!schedulePremium || !suggestAddress || scheduleDraft.tzPicked || editingScheduled) return undefined;
    let live = true;
    const timer = setTimeout(async () => {
      const suggestion = await useScheduledStore.getState().suggestTz(suggestAddress);
      if (!live) return;
      // Back to this machine's zone when there is nothing for this
      // recipient: a zone already there was suggested for someone else.
      const tz = suggestion?.tz || Intl.DateTimeFormat().resolvedOptions().timeZone;
      setScheduleDraft(d => (d.tzPicked || d.tz === tz ? d : { ...d, tz }));
      setTzSuggestion(suggestion && { ...suggestion, name: suggestName, address: suggestAddress });
    }, 250);
    return () => { live = false; clearTimeout(timer); };
  }, [schedulePremium, suggestAddress, suggestName, scheduleDraft.tzPicked, editingScheduled]);
}
