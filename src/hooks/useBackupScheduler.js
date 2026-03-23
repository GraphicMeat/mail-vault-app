import { useEffect, useRef } from 'react';
import { backupScheduler } from '../services/backupScheduler';

const IDLE_THRESHOLD_MS = 3 * 60 * 1000; // 3 minutes of no user activity
const IDLE_CHECK_INTERVAL_MS = 60_000;    // Check every 60 seconds
const WAKE_SETTLE_MS = 10_000;            // Wait 10s after wake for network recovery
const VISIBILITY_SETTLE_MS = 15_000;      // Wait 15s after tab visible + verify still idle

/**
 * React bridge for the backup coordinator.
 *
 * Tracks user activity, visibility, online/offline, and sleep/wake,
 * then feeds lifecycle events to the coordinator which owns all
 * scheduling decisions (gates, queue, pause/resume).
 */
export function useBackupScheduler() {
  const lastActivityRef = useRef(Date.now());
  const wasIdleRef = useRef(false);

  useEffect(() => {
    // ── Activity tracking ──────────────────────────────────────────────

    let throttled = false;
    const markActive = () => {
      if (throttled) return;
      throttled = true;
      lastActivityRef.current = Date.now();

      // If user becomes active during an automatic backup, notify coordinator
      if (wasIdleRef.current) {
        wasIdleRef.current = false;
        backupScheduler.onUserActive();
      }

      setTimeout(() => { throttled = false; }, 1000);
    };
    const events = ['keydown', 'click', 'scroll', 'touchstart'];
    events.forEach(e => document.addEventListener(e, markActive, { passive: true }));

    // mousemove tracked separately with longer throttle
    let mouseThrottled = false;
    const markMouseActive = () => {
      if (mouseThrottled) return;
      mouseThrottled = true;
      lastActivityRef.current = Date.now();
      if (wasIdleRef.current) {
        wasIdleRef.current = false;
        backupScheduler.onUserActive();
      }
      setTimeout(() => { mouseThrottled = false; }, 5000);
    };
    document.addEventListener('mousemove', markMouseActive, { passive: true });

    // ── Init progress event listener ───────────────────────────────────

    backupScheduler.initProgressListener();

    // ── Periodic idle check ────────────────────────────────────────────

    const idleInterval = setInterval(() => {
      const idleMs = Date.now() - lastActivityRef.current;
      if (idleMs >= IDLE_THRESHOLD_MS) {
        if (!wasIdleRef.current) {
          wasIdleRef.current = true;
          backupScheduler.onUserIdle();
        }
        // On each idle tick, also check if any backups are due
        backupScheduler.checkAndQueueDue();
      }
    }, IDLE_CHECK_INTERVAL_MS);

    // ── Sleep/wake detection ───────────────────────────────────────────

    let lastTick = Date.now();
    const heartbeat = setInterval(() => {
      const now = Date.now();
      const gap = now - lastTick;
      lastTick = now;
      if (gap > 30_000) {
        console.log(`[backup] Wake detected (${Math.round(gap / 1000)}s gap)`);
        backupScheduler.onSleep(); // mark as paused_sleep first
        // Wait for network recovery, then resume
        setTimeout(() => {
          console.log('[backup] Post-wake resume');
          backupScheduler.onWake();
        }, WAKE_SETTLE_MS);
      }
    }, 15_000);

    // ── Visibility change ──────────────────────────────────────────────
    // Only trigger backup check if user stays idle after returning to the app.
    // This prevents starting backups at exactly the wrong moment (user just switched back).

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        setTimeout(() => {
          const idleMs = Date.now() - lastActivityRef.current;
          if (idleMs >= IDLE_THRESHOLD_MS) {
            backupScheduler.checkAndQueueDue();
          }
        }, VISIBILITY_SETTLE_MS);
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);

    // ── Online/offline ─────────────────────────────────────────────────

    const handleOnline = () => backupScheduler.onOnline();
    const handleOffline = () => backupScheduler.onOffline();
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    // ── Cleanup ────────────────────────────────────────────────────────

    return () => {
      events.forEach(e => document.removeEventListener(e, markActive));
      document.removeEventListener('mousemove', markMouseActive);
      clearInterval(idleInterval);
      clearInterval(heartbeat);
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      backupScheduler.stopAll();
    };
  }, []);
}
