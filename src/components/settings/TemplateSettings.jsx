import React from 'react';
import { useSettingsStore } from '../../stores/settingsStore';
import { DesktopViewEnv } from './DesktopViewEnv';
import { TemplatesView } from './views/TemplatesView';

/** Desktop's container: the settings store's templates over TemplatesView. */
export function TemplateSettings() {
  const { emailTemplates, addEmailTemplate, updateEmailTemplate, removeEmailTemplate } = useSettingsStore();
  return (
    <DesktopViewEnv>
      <TemplatesView templates={emailTemplates}
        onAdd={(name, body) => addEmailTemplate(name, body)}
        onUpdate={(_index, tpl, patch) => updateEmailTemplate(tpl.id, patch)}
        onRemove={(_index, tpl) => removeEmailTemplate(tpl.id)} />
    </DesktopViewEnv>
  );
}
