import React from 'react';
import { useSettingsStore } from '../../stores/settingsStore';
import { ColorSchemeSettings } from './ColorSchemeSettings';
import { TextSettings } from './TextSettings';
import { WorkspaceSettings } from './WorkspaceSettings';
import { QuickActionsSettings } from './QuickActionsSettings';
import { LanguageSettings } from './LanguageSettings';
import { BodyRendererSettingsSlot } from '../email/bodyRendererRegistry';
import { AppearanceView, validAppearanceSection } from './views/AppearanceView';
import { DateTimeView, ReadingView } from './views/ReadingDateViews';
import { DesktopViewEnv } from './DesktopViewEnv';

// Match App's stacked-layout breakpoint so the explanation reflects the
// actual window, while preserving the user's preferred reading-pane layout.
function useWindowIsNarrow() {
  const [narrow, setNarrow] = React.useState(
    () => window.matchMedia('(max-width: 767px)').matches,
  );
  React.useEffect(() => {
    const media = window.matchMedia('(max-width: 767px)');
    const onChange = event => setNarrow(event.matches);
    media.addEventListener('change', onChange);
    setNarrow(media.matches);
    return () => media.removeEventListener('change', onChange);
  }, []);
  return narrow;
}

const setterOf = key => `set${key[0].toUpperCase()}${key.slice(1)}`;

/** Desktop's container: the settings store over AppearanceView and its section views. */
export function AppearanceSettings({ initialSection = 'colors', onSectionChange }) {
  const windowIsNarrow = useWindowIsNarrow();
  const settings = useSettingsStore();
  const [section, setSection] = React.useState(() => validAppearanceSection(initialSection));
  React.useEffect(() => setSection(validAppearanceSection(initialSection)), [initialSection]);
  const set = (key, value) => settings[setterOf(key)](value);
  return (
    <DesktopViewEnv>
      <AppearanceView section={section} onSectionChange={value => { setSection(value); onSectionChange?.(value); }}>
        {section === 'colors' && <>
          <ColorSchemeSettings />
          {/* Rows contributed by registered body renderers, right after the email theme row. */}
          <BodyRendererSettingsSlot />
        </>}
        {section === 'text' && <TextSettings />}
        {section === 'layout' && <WorkspaceSettings windowIsNarrow={windowIsNarrow} />}
        {section === 'quick-actions' && <QuickActionsSettings />}
        {section === 'language' && <LanguageSettings />}
        {section === 'reading' && <ReadingView values={settings} onChange={set} />}
        {section === 'date-time' && <DateTimeView values={settings} onChange={set} systemLanguage={navigator.language} />}
      </AppearanceView>
    </DesktopViewEnv>
  );
}
