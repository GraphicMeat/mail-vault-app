// Settings > Templates on the phone: desktop's Templates view over the engine preference
// `templates` (`mobile.prefs.set`, a list of `{name, body}`; one from a desktop import may carry
// more, such as its `id`, which is kept). Compose inserts them ("Templates" in its body row). The
// whole list is written on each change; a refused write keeps the form open and says so.
import React from 'react';
import { TemplatesView } from '../../components/settings/views/TemplatesView';
import { useMobileStore } from '../store.js';
import { MobileViewEnv, SaveFailed, useSavePrefs } from './MobileViewEnv.jsx';

export default function Templates() {
  const templates = useMobileStore((s) => s.prefs.templates) || [];
  const [save, failed] = useSavePrefs();
  const write = (next) => save({ templates: next });
  return (
    <MobileViewEnv>
      <TemplatesView templates={templates}
        onAdd={(name, body) => write([...templates, { name, body }])}
        onUpdate={(index, _tpl, patch) => write(templates.map((x, i) => (i === index ? { ...x, ...patch } : x)))}
        onRemove={(index) => write(templates.filter((_, i) => i !== index))}
        notice={<SaveFailed failed={failed} />} />
    </MobileViewEnv>
  );
}
