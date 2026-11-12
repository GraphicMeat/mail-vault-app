import { useEffect } from 'react';
import { hasOpenPopover } from '../../hooks/useDialogA11y';

export function useDismissPopovers({ showTemplates, templatesRef, setShowTemplates, setSavingTemplate, showSchedulePicker, scheduleRef, setShowSchedulePicker }) {
  // Close templates dropdown on click outside or Escape
  useEffect(() => {
    if (!showTemplates) return;
    const handleClick = (e) => {
      if (templatesRef.current && !templatesRef.current.contains(e.target)) {
        setShowTemplates(false);
        setSavingTemplate(false);
      }
    };
    const handleKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setShowTemplates(false);
        setSavingTemplate(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    // Capture phase so this runs before the modal-level Escape handler,
    // letting us stopPropagation and keep the compose modal open while
    // the templates dropdown is visible.
    document.addEventListener('keydown', handleKey, true);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey, true);
    };
  }, [showTemplates]);

  // Close the schedule popover on click outside or Escape — same shape as
  // the templates dropdown above. The picker's calendar and zone list are
  // portaled to body, outside scheduleRef: while one is open it owns the
  // outside click and the Escape, and only that layer closes.
  useEffect(() => {
    if (!showSchedulePicker) return;
    const handleClick = (e) => {
      if (hasOpenPopover()) return;
      if (scheduleRef.current && !scheduleRef.current.contains(e.target)) setShowSchedulePicker(false);
    };
    const handleKey = (e) => {
      if (e.key === 'Escape' && !hasOpenPopover()) { e.stopPropagation(); setShowSchedulePicker(false); }
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey, true);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey, true);
    };
  }, [showSchedulePicker]);
}
