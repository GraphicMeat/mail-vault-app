// Settings > Mail preferences > Templates: the reusable messages compose inserts ("Templates" in
// its body row), as desktop's Templates page keeps them: a name and a plain-text body each. Stored
// as the engine preference `templates` (`mobile.prefs.set`, a list of `{name, body}`; one from a
// desktop import may carry more, such as its `id`, which is kept). Add opens an inline form; each
// row has Edit and Delete. The whole list is written on each change.
import React, { useId, useState } from 'react';
import { useMobileStore } from './store.js';
import { useT } from './i18n.js';

export default function TemplatesSettings({ onFailed }) {
  const t = useT();
  const id = useId();
  const templates = useMobileStore((s) => s.prefs.templates) || [];
  const [form, setForm] = useState(null); // null | { at: index or -1 for a new one }
  const [name, setName] = useState('');
  const [body, setBody] = useState('');

  const write = async (next) => {
    const ok = await useMobileStore.getState().setPrefs({ templates: next });
    onFailed?.(!ok);
    return ok;
  };
  const open = (at) => {
    setForm({ at });
    setName(at >= 0 ? templates[at].name || '' : '');
    setBody(at >= 0 ? templates[at].body || '' : '');
  };
  const save = async () => {
    const entry = { name: name.trim(), body };
    const next = form.at >= 0 ? templates.map((x, i) => (i === form.at ? { ...x, ...entry } : x)) : [...templates, entry];
    if (await write(next)) setForm(null);
  };

  return (
    <>
      <h2 className="mv-settings__heading">{t('settings.tab.templates')}</h2>
      <div className="mv-settings__list" data-mv-templates>
        {templates.length === 0 && !form && <p className="mv-setting__hint mv-templates__empty">{t('settings.templates.noTemplatesYetCreateOne')}</p>}
        {templates.map((tpl, i) => (
          // eslint-disable-next-line react/no-array-index-key -- an imported template may have no id
          <div key={i} className="mv-setting mv-templates__row">
            <span className="mv-setting__text">
              <span className="mv-setting__label" dir="auto">{tpl.name}</span>
              <span className="mv-setting__hint mv-templates__preview" dir="auto">{tpl.body}</span>
            </span>
            <button type="button" className="mv-textbtn" aria-label={`${t('settings.templates.editTemplate')}: ${tpl.name}`} onClick={() => open(i)}>
              {t('outbox.edit')}
            </button>
            <button
              type="button"
              className="mv-textbtn mv-textbtn--danger"
              aria-label={`${t('settings.templates.deleteTemplate')}: ${tpl.name}`}
              onClick={() => write(templates.filter((_, j) => j !== i))}
            >
              {t('common.delete')}
            </button>
          </div>
        ))}
        {form ? (
          <div className="mv-acct-edit mv-templates__form">
            <label className="mv-acct-edit__field" htmlFor={`${id}-name`}>
              <span className="mv-setting__label">{t('settings.templates.templateName')}</span>
              <input id={`${id}-name`} className="mv-setting__input" dir="auto" maxLength={200} value={name}
                placeholder={t('settings.templates.eGFollowUpThank')} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="mv-acct-edit__field" htmlFor={`${id}-body`}>
              <span className="mv-setting__label">{t('settings.templates.templateBody')}</span>
              <textarea id={`${id}-body`} className="mv-setting__input mv-acct-edit__sig" dir="auto" rows={5} value={body}
                placeholder={t('settings.templates.writeTemplateContentHere')} onChange={(e) => setBody(e.target.value)} />
            </label>
            <div className="mv-acct__actions">
              <button type="button" className="mv-textbtn" onClick={() => setForm(null)}>{t('common.cancel')}</button>
              <button type="button" className="mv-textbtn" disabled={!name.trim() || !body.trim()} onClick={save}>{t('common.save')}</button>
            </div>
          </div>
        ) : (
          <button type="button" className="mv-setting" onClick={() => open(-1)}>
            <span className="mv-setting__text"><span className="mv-setting__label">{t('settings.templates.addTemplate')}</span></span>
          </button>
        )}
      </div>
    </>
  );
}
