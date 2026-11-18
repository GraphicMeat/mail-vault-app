// Desktop's preference examples: the views in views/PreviewViews.jsx, fed from the desktop
// stores and wrapped in the desktop context (DesktopViewEnv) so each export works where it is
// used bare (onboarding, behavior settings).
import React from 'react';
import { PREVIEW_ACCOUNTS } from '../../data/previewMail';
import { SampleConversation } from '../ui/SampleConversation';
import { useThemeStore } from '../../stores/themeStore';
import { getAccountColor, useSettingsStore } from '../../stores/settingsStore';
import { getEmailColors } from '../../utils/mailChrome';
import { withDesktopEnv } from './DesktopViewEnv';
import {
  PreviewFrame as PreviewFrameView, ColorOptionPreview as ColorOptionPreviewView, EmailThemePreviewView,
  WorkspacePreviewView, SidebarLayoutPreview as SidebarLayoutPreviewView, ReadingPreview as ReadingPreviewView,
  DateTimePreview as DateTimePreviewView, AfterDeletePreviewView,
} from './views/PreviewViews';

// Quick actions is the exception to "illustrative only": QuickActionSamples.jsx draws the real
// components, inert, over the person's own mail.

export const PreviewFrame = withDesktopEnv(PreviewFrameView);
export const ColorOptionPreview = withDesktopEnv(ColorOptionPreviewView);
export const SidebarLayoutPreview = withDesktopEnv(SidebarLayoutPreviewView);
export const ReadingPreview = withDesktopEnv(ReadingPreviewView);
export const DateTimePreview = withDesktopEnv(DateTimePreviewView);

export const EmailThemePreview = withDesktopEnv(function EmailThemePreview() {
  const { theme, palette } = useThemeStore();
  const preference = useSettingsStore(s => s.emailViewerTheme);
  const effectiveTheme = preference === 'system' ? theme : preference;
  return <EmailThemePreviewView effectiveTheme={effectiveTheme} colors={getEmailColors(effectiveTheme, palette)} />;
});

export const WorkspacePreview = withDesktopEnv(function WorkspacePreview(props) {
  const layoutMode = useSettingsStore(s => s.layoutMode);
  const sidebarDensity = useSettingsStore(s => s.sidebarDensity);
  const emailListStyle = useSettingsStore(s => s.emailListStyle);
  return <WorkspacePreviewView {...props} layoutMode={layoutMode} sidebarDensity={sidebarDensity} emailListStyle={emailListStyle}
    accounts={PREVIEW_ACCOUNTS} accountColor={account => getAccountColor({}, account)} chatSample={<SampleConversation compact />} />;
});

export const AfterDeletePreview = withDesktopEnv(AfterDeletePreviewView);
