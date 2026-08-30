import { describe, it, expect, beforeEach } from 'vitest';
import { setLocale, t } from '../../src/i18n/index.js';
import { useSettingsStore } from '../../src/stores/settingsStore';

/**
 * The app reads its language from a store persisted through Tauri, so
 * `safeStorage.getItem` returns a Promise and zustand hydrates asynchronously.
 * `main.jsx` applies the locale at import — before that lands — so it always
 * sees the default `en`, and the real value arrives afterwards by being merged
 * straight into the store.
 *
 * That merge repaints every `useT` subscriber (they select `s.language`) while
 * `_catalog` is still English: German ticked on the Language page, English
 * everywhere else, on every restart.
 *
 * The fix re-applies the locale once hydration finishes. For that second call
 * to repaint anything, publishing has to change a value — and `language` is
 * already `de` by then.
 */
describe('locale after an async rehydration', () => {
  beforeEach(async () => {
    await setLocale('en');
  });

  it('loads the catalog before it publishes', async () => {
    await setLocale('de');
    expect(useSettingsStore.getState().language).toBe('de');
    expect(t('settings.tab.general')).not.toBe('General');
  });

  it('repaints even when the language field already holds the target code', async () => {
    // Exactly the post-rehydration case: the store says `de` while the catalog
    // is still English, so re-applying `de` must still bump a subscribed value.
    useSettingsStore.setState({ language: 'de' });
    const before = useSettingsStore.getState().localeEpoch;
    await setLocale('de');
    const after = useSettingsStore.getState().localeEpoch;
    expect(after).toBeGreaterThan(before);
    expect(t('settings.tab.general')).not.toBe('General');
  });

  it('still repaints on a genuine switch', async () => {
    const before = useSettingsStore.getState().localeEpoch;
    await setLocale('ja');
    expect(useSettingsStore.getState().localeEpoch).toBeGreaterThan(before);
  });
});
