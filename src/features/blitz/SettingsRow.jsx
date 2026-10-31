import React from 'react';
import { useT } from '../../i18n/index.js';
import { useSettingsStore } from '../../stores/settingsStore';
import { SettingRow } from '../../components/ui/SettingRow';
import { ToggleSwitch } from '../../components/ui/ToggleSwitch';
import GpuRow from './GpuRow';

/** Settings > Appearance row that turns the Rust renderer on and off, and, while it is on, its graphics-card option. */
export default function SettingsRow() {
  const t = useT();
  const on = useSettingsStore(s => s.emailRenderer === 'blitz');
  const setEmailRenderer = useSettingsStore(s => s.setEmailRenderer);
  return (
    <section className="settings-preference-group">
      <SettingRow label={t('blitz.settings.title')} description={`${t('blitz.settings.description')} ${t('blitz.settings.privacy')}`}>
        <ToggleSwitch label={t('blitz.settings.title')} testId="setting-email-renderer" active={on} onClick={() => setEmailRenderer(on ? 'web' : 'blitz')} />
      </SettingRow>
      {on && <GpuRow />}
    </section>
  );
}
