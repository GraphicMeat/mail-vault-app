import { useEffect } from 'react';
import { useMailStore } from '../stores/mailStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useLifecycleStore } from '../stores/lifecycleStore';

/** A window focus asks the daemon again only when the last answer is older than this. */
export const FOCUS_GAP_MS = 10 * 60 * 1000;

/**
 * Keeps the lifecycle messages current: asks the daemon when the app starts,
 * when billing, onboarding or the on/off switch changes (those decide most
 * messages), and when the window regains focus after a while. Opening a real
 * email closes an open message, so the reader never shows both.
 */
export function useLifecycleMail() {
  const billingProfile = useSettingsStore((s) => s.billingProfile);
  const enabled = useSettingsStore((s) => s.lifecycleMessages);
  const onboardingComplete = useSettingsStore((s) => s.onboardingComplete);
  const selectedEmailId = useMailStore((s) => s.selectedEmailId);

  useEffect(() => { useLifecycleStore.getState().sync(); }, [billingProfile, enabled, onboardingComplete]);

  useEffect(() => {
    const onFocus = () => {
      const { lastSyncAt, sync } = useLifecycleStore.getState();
      if (Date.now() - lastSyncAt >= FOCUS_GAP_MS) sync();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  useEffect(() => {
    if (selectedEmailId) useLifecycleStore.getState().close();
  }, [selectedEmailId]);
}
