import React from 'react';
import { useSettingsStore, normalizeListPreviewLines, getAccountColor } from '../../stores/settingsStore';
import { PREVIEW_ACCOUNTS } from '../../data/previewMail';
import { SampleConversation } from '../ui/SampleConversation';
import { IS_LINUX } from '../../utils/menuBar';
import { WORKSPACE_ROWS, WorkspaceView } from './views/WorkspaceView';
import { DesktopViewEnv } from './DesktopViewEnv';

// The menu bar row is Linux's only (its File/Logs menu bar).
const ROWS = WORKSPACE_ROWS.filter(key => key !== 'showMenuBar' || IS_LINUX);
const setterOf = key => `set${key[0].toUpperCase()}${key.slice(1)}`;

/** Desktop's container: the settings store over WorkspaceView, every row. */
export function WorkspaceSettings({ windowIsNarrow }) {
  const settings = useSettingsStore();
  const values = { ...settings, listPreviewLines: normalizeListPreviewLines(settings.listPreviewLines) };
  return (
    <DesktopViewEnv>
      <WorkspaceView values={values} onChange={(key, value) => settings[setterOf(key)](value)} rows={ROWS}
        windowIsNarrow={windowIsNarrow}
        preview={{ accounts: PREVIEW_ACCOUNTS, accountColor: account => getAccountColor({}, account), chatSample: <SampleConversation compact /> }} />
    </DesktopViewEnv>
  );
}
