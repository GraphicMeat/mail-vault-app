import React from 'react';
import { useSettingsStore } from '../../stores/settingsStore';
import { DesktopViewEnv } from '../settings/DesktopViewEnv';
import { SampleConversationView } from '../settings/views/PreviewViews';

/** The selected Chat topic fills the pane: the shared view in the desktop context. */
export function SampleConversation({ compact = false }) {
  // The times follow the time format.
  useSettingsStore(s => s.timeFormat);
  return <DesktopViewEnv><SampleConversationView compact={compact} /></DesktopViewEnv>;
}
