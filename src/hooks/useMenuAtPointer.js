import { useCallback, useRef, useState } from 'react';

/// A right-click opens the row's quick actions at the pointer, in whatever
/// layout the row surface is configured for (radial, menu, …), instead of the
/// webview's own Reload menu. A new object per click is what reopens it.
///
/// Windows fires `contextmenu` on mouse-up, not mouse-down: waiting for it
/// costs a full click of latency before the wheel appears. Opening on
/// `pointerdown` (button 2) instead paints it immediately.
///
/// Not every gesture that opens a context menu delivers a button-2 pointer
/// event first: macOS Ctrl+click is a plain button-0 click with `ctrlKey`,
/// and the keyboard Menu key / Shift+F10 and a touch long-press never fire a
/// pointerdown at all. All of those only ever reach `contextmenu`, so it has
/// to be a fallback opener, not just an OS-menu-suppressor — but a real
/// right-click's `contextmenu` (which follows its own button-2 pointerdown)
/// must still only swallow the OS menu, not reopen or move the wheel that
/// pointerdown already placed. `openedByPointerDownRef` is that "already
/// handled this gesture" flag.
///
/// It is set by pointerdown alone, with no timer: Windows fires `contextmenu`
/// on mouse-UP, so a right-press held past any fixed timeout would clear the
/// flag before its own contextmenu arrives, opening the wheel a second time
/// at the release point. Every pointerdown instead resets the flag outright —
/// true for button 2, false for anything else — so a right-press that never
/// gets a matching contextmenu (dragged off, cancelled, whatever) is wiped by
/// the very next pointerdown of any button, rather than lingering to swallow
/// a later, unrelated Ctrl+click.
///
/// `live` says whether the row should mount its quick actions at all: only
/// while it is hovered, focused, right-clicked or swiped. Mounting them on every row
/// of a long list cost two dozen store subscriptions and a portal per row.
/// Whoever opened a menu or picker from them holds the row live on its own
/// (EmailList's `activeMenuRowId`), since the pointer leaves the row for it.
export function useMenuAtPointer() {
  const [menuAt, setMenuAt] = useState(null);
  const [live, setLive] = useState(false);
  const openedByPointerDownRef = useRef(false);
  const openMenuAtPointer = useCallback((event) => {
    openedByPointerDownRef.current = event.button === 2;
    if (event.button !== 2) return;
    setLive(true);
    setMenuAt({ x: event.clientX, y: event.clientY });
  }, []);
  const openMenuFromContextMenu = useCallback((event) => {
    event.preventDefault();
    if (openedByPointerDownRef.current) {
      openedByPointerDownRef.current = false;
      return;
    }
    // No button-2 pointerdown opened this gesture. A keyboard-triggered
    // contextmenu carries no real pointer position (0,0): anchor to the row
    // itself instead of the screen origin.
    const atOrigin = event.clientX === 0 && event.clientY === 0;
    const rect = atOrigin ? event.currentTarget?.getBoundingClientRect() : null;
    setLive(true);
    setMenuAt({
      x: rect ? rect.left + rect.width / 2 : event.clientX,
      y: rect ? rect.top + rect.height / 2 : event.clientY,
    });
  }, []);
  return [menuAt, {
    onPointerDown: openMenuAtPointer,
    onContextMenu: openMenuFromContextMenu,
    onPointerEnter: () => setLive(true),
    onPointerLeave: () => setLive(false),
    // A trackpad swipe runs through the row's quick actions (useRowSwipe), and
    // after a scroll under a still pointer no hover may have reached the row.
    onWheel: (event) => { if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) setLive(true); },
    onFocus: () => setLive(true),
    // Only focus that moved on to something outside the row lets go. Focus
    // sent nowhere is the right-click's own mousedown dropping it from the
    // wedge the wheel just focused; the pointer is still on the row.
    onBlur: (event) => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setLive(false); },
  }, live];
}
