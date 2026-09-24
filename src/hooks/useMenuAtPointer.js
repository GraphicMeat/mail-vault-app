import { useCallback, useState } from 'react';

/// A right-click opens the row's quick actions at the pointer, in whatever
/// layout the row surface is configured for (radial, menu, …), instead of the
/// webview's own Reload menu. A new object per click is what reopens it.
export function useMenuAtPointer() {
  const [menuAt, setMenuAt] = useState(null);
  const openMenuAtPointer = useCallback((event) => {
    event.preventDefault();
    setMenuAt({ x: event.clientX, y: event.clientY });
  }, []);
  return [menuAt, openMenuAtPointer];
}
