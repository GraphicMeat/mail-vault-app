import { useCallback, useState } from 'react';

/// A right-click opens the row's quick actions at the pointer, in whatever
/// layout the row surface is configured for (radial, menu, …), instead of the
/// webview's own Reload menu. A new object per click is what reopens it.
///
/// Windows fires `contextmenu` on mouse-up, not mouse-down: waiting for it
/// costs a full click of latency before the wheel appears. Opening on
/// `pointerdown` (button 2) instead paints it immediately; the `contextmenu`
/// that follows only swallows the OS menu, it must not reopen or move the one
/// already on screen.
export function useMenuAtPointer() {
  const [menuAt, setMenuAt] = useState(null);
  const openMenuAtPointer = useCallback((event) => {
    if (event.button !== 2) return;
    setMenuAt({ x: event.clientX, y: event.clientY });
  }, []);
  const suppressContextMenu = useCallback((event) => {
    event.preventDefault();
  }, []);
  return [menuAt, { onPointerDown: openMenuAtPointer, onContextMenu: suppressContextMenu }];
}
