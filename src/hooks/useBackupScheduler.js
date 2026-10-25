import { useEffect } from 'react';
import { send } from '../services/transport';
import { backupScheduler } from '../services/backupScheduler';
import { useMailStore } from '../stores/mailStore';

/** One sensor publisher per webview. Native owns every eligibility timer. */
export function useBackupScheduler({ main = true } = {}) {
  useEffect(() => {
    const surfaceId = window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label || 'browser';
    let sessionId = crypto.randomUUID();
    let sequence = 0;
    let retired = false;
    let activity = Date.now();
    let tick = activity;
    let keyAt = -Infinity;
    let mouseAt = -Infinity;
    const facts = (kind = 'update', extra = {}) => {
      if (retired && kind !== 'retire') return;
      const payload = { surfaceId, sessionId, sequence: ++sequence, kind };
      if (kind !== 'retire') Object.assign(payload, {
        lastActivityAt: activity, observedAt: Date.now(), loading: main && !!useMailStore.getState().loading,
        visibility: document.visibilityState === 'hidden' ? 'hidden' : 'visible', online: navigator.onLine !== false, ...extra,
      });
      Promise.resolve().then(() => send('backup.context', payload)).catch(() => {});
    };
    facts('attach');
    let reconnectUnlisten;
    import('@tauri-apps/api/event').then(async ({ listen }) => {
      const unlisten = await listen('daemon-reconnected', () => {
        if (retired) return;
        facts('retire'); sessionId = crypto.randomUUID(); sequence = 0; facts('attach');
      });
      if (retired) unlisten(); else reconnectUnlisten = unlisten;
    }).catch(() => {});
    let observer = backupScheduler.observe?.({ present: main });
    const probe = { detach() { observer?.(); observer = null; }, attach() { if (!retired && !observer) observer = backupScheduler.observe?.({ present: main }); } };
    if (import.meta.env.VITE_E2E === '1') window.__BACKUP_UI_OBSERVER__ = probe;
    const markActive = () => {
      const now = Date.now(); if (now - keyAt < 1000) return;
      keyAt = activity = now; facts();
    };
    const mouse = () => {
      const now = Date.now(); if (now - mouseAt < 5000) return;
      mouseAt = activity = now; facts();
    };
    const events = ['keydown', 'click', 'scroll', 'touchstart'];
    events.forEach(e => document.addEventListener(e, markActive, { passive: true }));
    document.addEventListener('mousemove', mouse, { passive: true });
    const visibility = () => facts();
    const network = () => facts();
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('online', network); window.addEventListener('offline', network);
    const loading = main ? useMailStore.subscribe((state, prev) => { if (state.loading !== prev.loading) facts(); }) : () => {};
    const heartbeat = setInterval(() => { const now = Date.now(); const gap = now - tick; tick = now; facts('update', { heartbeatGap: gap }); }, 15_000);
    const retire = () => { if (retired) return; retired = true; facts('retire'); };
    window.addEventListener('beforeunload', retire);
    return () => {
      retire(); clearInterval(heartbeat); loading(); observer?.(); reconnectUnlisten?.();
      if (window.__BACKUP_UI_OBSERVER__ === probe) delete window.__BACKUP_UI_OBSERVER__;
      events.forEach(e => document.removeEventListener(e, markActive));
      document.removeEventListener('mousemove', mouse);
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('online', network); window.removeEventListener('offline', network);
      window.removeEventListener('beforeunload', retire);
    };
  }, [main]);
}
