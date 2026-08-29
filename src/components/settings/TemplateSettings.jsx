import React, { useState } from 'react';
import { useSettingsStore } from '../../stores/settingsStore';
import { motion, AnimatePresence } from 'framer-motion';
import {
  FileText,
  Trash2,
  Plus,
  PenTool,
  Save,
} from 'lucide-react';
import { useT } from '../../i18n/index.js';

export function TemplateSettings() {
  const t = useT();
  const {
    emailTemplates,
    addEmailTemplate,
    updateEmailTemplate,
    removeEmailTemplate,
  } = useSettingsStore();

  const [templateForm, setTemplateForm] = useState(null); // null | { mode: 'add' } | { mode: 'edit', id }
  const [templateName, setTemplateName] = useState('');
  const [templateBody, setTemplateBody] = useState('');

  return (
    <div className="p-6 space-y-6">
      <div data-testid="settings-templates" className="bg-mail-surface border border-mail-border rounded-xl p-5">
        <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
          <FileText size={18} className="text-mail-accent-text" />
          {t('settings.templates.emailTemplates')}
        </h4>

        <p className="text-sm text-mail-text-muted mb-4">
          {t('settings.templates.createReusableTemplatesCommonEmails')}
        </p>

        <div className="space-y-3">
          {emailTemplates.map((tpl) => (
            <div key={tpl.id} className="flex items-center justify-between p-3 bg-mail-bg rounded-lg">
              <div className="flex-1 min-w-0 mr-3">
                <div className="text-sm font-medium text-mail-text truncate">{tpl.name}</div>
                <div className="text-xs text-mail-text-muted truncate">
                  {tpl.body.length > 50 ? tpl.body.slice(0, 50) + '...' : tpl.body}
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  onClick={() => {
                    setTemplateForm({ mode: 'edit', id: tpl.id });
                    setTemplateName(tpl.name);
                    setTemplateBody(tpl.body);
                  }}
                  className="p-1.5 text-mail-text-muted hover:text-mail-text hover:bg-mail-border rounded-lg transition-colors"
                  title={t('settings.templates.editTemplate')}
                >
                  <PenTool size={14} />
                </button>
                <button
                  onClick={() => removeEmailTemplate(tpl.id)}
                  className="p-1.5 text-mail-text-muted hover:text-mail-danger hover:bg-mail-border rounded-lg transition-colors"
                  title={t('settings.templates.deleteTemplate')}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}

          {emailTemplates.length === 0 && !templateForm && (
            <div className="text-sm text-mail-text-muted text-center py-3">
              {t('settings.templates.noTemplatesYetCreateOne')}
            </div>
          )}

          <AnimatePresence>
            {templateForm && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                className="overflow-hidden"
              >
                <div className="p-4 bg-mail-bg rounded-lg border border-mail-border space-y-3">
                  <div>
                    <label className="block text-sm font-medium text-mail-text mb-1">
                      {t('settings.templates.templateName')}
                    </label>
                    <input
                      type="text"
                      value={templateName}
                      onChange={(e) => setTemplateName(e.target.value)}
                      placeholder={t('settings.templates.eGFollowUpThank')}
                      className="w-full px-3 py-2 bg-mail-surface border border-mail-border rounded-lg
                                text-sm text-mail-text placeholder-mail-text-muted
                                focus:border-mail-accent focus:outline-none transition-colors"
                      autoFocus
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-mail-text mb-1">
                      {t('settings.templates.templateBody')}
                    </label>
                    <textarea
                      value={templateBody}
                      onChange={(e) => setTemplateBody(e.target.value)}
                      placeholder={t('settings.templates.writeTemplateContentHere')}
                      rows={5}
                      className="w-full px-3 py-2 bg-mail-surface border border-mail-border rounded-lg
                                text-sm text-mail-text placeholder-mail-text-muted
                                focus:border-mail-accent focus:outline-none transition-colors resize-y"
                    />
                  </div>
                  <div className="flex items-center gap-2 justify-end">
                    <button
                      onClick={() => {
                        setTemplateForm(null);
                        setTemplateName('');
                        setTemplateBody('');
                      }}
                      className="px-3 py-1.5 text-sm text-mail-text-muted hover:text-mail-text
                                hover:bg-mail-border rounded-lg transition-colors"
                    >
                      {t('common.cancel')}
                    </button>
                    <button
                      onClick={() => {
                        const name = templateName.trim();
                        const body = templateBody.trim();
                        if (!name || !body) return;
                        if (templateForm.mode === 'add') {
                          addEmailTemplate(name, body);
                        } else {
                          updateEmailTemplate(templateForm.id, { name, body });
                        }
                        setTemplateForm(null);
                        setTemplateName('');
                        setTemplateBody('');
                      }}
                      disabled={!templateName.trim() || !templateBody.trim()}
                      className="px-3 py-1.5 text-sm bg-mail-accent-fill text-white rounded-lg
                                hover:opacity-90 transition-all disabled:opacity-50 disabled:cursor-not-allowed
                                flex items-center gap-1.5"
                    >
                      <Save size={14} />
                      {templateForm.mode === 'add' ? 'Save' : 'Update'}
                    </button>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {!templateForm && (
            <button
              onClick={() => {
                setTemplateForm({ mode: 'add' });
                setTemplateName('');
                setTemplateBody('');
              }}
              className="flex items-center gap-2 px-3 py-2 text-sm text-mail-accent-text
                        hover:bg-mail-bg rounded-lg transition-colors w-full justify-center
                        border border-dashed border-mail-border hover:border-mail-accent"
            >
              <Plus size={14} />
              {t('settings.templates.addTemplate')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
