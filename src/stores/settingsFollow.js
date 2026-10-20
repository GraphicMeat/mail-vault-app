// The persisted stores a settings change made elsewhere (another window, the
// daemon) is applied to: safeStorage takes `settings-changed` in and sets the
// fields that changed. Registered here, from the app entry, so the store
// modules themselves import nothing new.
import { registerPersistedStore } from './safeStorage';
import { useSettingsStore } from './settingsStore';
import { useThemeStore } from './themeStore';
import { usePrivacyStore } from './privacyStore';
import { useFocusStore } from './focusStore';

for (const store of [useSettingsStore, useThemeStore, usePrivacyStore, useFocusStore]) registerPersistedStore(store);
