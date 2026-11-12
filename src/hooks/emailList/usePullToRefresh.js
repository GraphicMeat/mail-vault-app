import { useCallback, useRef, useState } from 'react';
import { useMailStore } from '../../stores/mailStore';

export function usePullToRefresh({ scrollContainerRef }) {
  // Pull-to-refresh
  const [pullDistance, setPullDistance] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const pullStartY = useRef(null);
  const isPulling = useRef(false);

  // Pull-to-refresh handlers
  const PULL_THRESHOLD = 80;

  const handleTouchStart = useCallback((e) => {
    if (scrollContainerRef.current?.scrollTop === 0 && !isRefreshing) {
      pullStartY.current = e.touches[0].clientY;
      isPulling.current = true;
    }
  }, [isRefreshing]);

  const handleTouchMove = useCallback((e) => {
    if (!isPulling.current || pullStartY.current === null) return;
    const y = e.touches[0].clientY;
    const distance = Math.max(0, (y - pullStartY.current) * 0.5);
    if (distance > 0 && scrollContainerRef.current?.scrollTop === 0) {
      setPullDistance(Math.min(distance, PULL_THRESHOLD * 1.5));
    }
  }, []);

  const handleTouchEnd = useCallback(async () => {
    if (!isPulling.current) return;
    isPulling.current = false;
    pullStartY.current = null;

    if (pullDistance >= PULL_THRESHOLD) {
      setIsRefreshing(true);
      setPullDistance(PULL_THRESHOLD * 0.6);
      try {
        await useMailStore.getState().refreshCurrentView();
      } finally {
        setIsRefreshing(false);
        setPullDistance(0);
      }
    } else {
      setPullDistance(0);
    }
  }, [pullDistance]);

  return { pullDistance, isRefreshing, handleTouchStart, handleTouchMove, handleTouchEnd, PULL_THRESHOLD };
}
