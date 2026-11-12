import { useEffect, useRef } from 'react';

export function useAutoCollapseSidebar({ windowWidth, sidebarCollapsed, setSidebarCollapsed }) {
  const autoCollapsedRef = useRef(false); // true = sidebar was collapsed by responsive, not by user

  // If user manually expands sidebar while auto-collapsed, clear the flag
  // (so window resize won't re-expand what user explicitly collapsed later)
  const prevCollapsedRef = useRef(sidebarCollapsed);
  useEffect(() => {
    const prev = prevCollapsedRef.current;
    prevCollapsedRef.current = sidebarCollapsed;
    // User manually expanded while we auto-collapsed → clear flag
    if (prev && !sidebarCollapsed && autoCollapsedRef.current) {
      autoCollapsedRef.current = false;
    }
    // User manually collapsed while window is wide → ensure we don't auto-expand
    if (!prev && sidebarCollapsed && windowWidth >= 900) {
      autoCollapsedRef.current = false;
    }
  }, [sidebarCollapsed]);

  // Auto-collapse sidebar on narrow windows
  useEffect(() => {
    if (windowWidth < 900 && !sidebarCollapsed) {
      autoCollapsedRef.current = true;
      setSidebarCollapsed(true);
    } else if (windowWidth >= 900 && sidebarCollapsed && autoCollapsedRef.current) {
      autoCollapsedRef.current = false;
      setSidebarCollapsed(false);
    }
  }, [windowWidth]);
}
