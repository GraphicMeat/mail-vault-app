// Settings > AI: desktop's AI providers page with the phone's one provider, an OpenAI-compatible
// endpoint (an Ollama or OpenAI-style server). There is no on-device model on the phone, so the
// provider is not a choice here. Rows: Enable AI features (`aiEnabled`); then the endpoint URL
// (`aiEndpointUrl`) and model (`aiEndpointModel`), saved when the field is left; the API key,
// stored in the platform secret store by the engine (`mobile.ai.setKey`) and never shown again;
// "Skip review before sending" (`aiSkipPreview`); and "Send test message", which goes through the
// same review as every action (AiActions.jsx) and, sent, counts as reviewing this endpoint.
// Gmail mail never goes to a network endpoint (the engine refuses it); the note says so.
import React, { useEffect, useId, useState } from 'react';
import { daemonCall } from './transport.js';
import { useMobileStore } from './store.js';
import { useT } from './i18n.js';
import { useAiAction } from './AiActions.jsx';

// Example values, not text: the same in every language.
const URL_EXAMPLE = 'https://ollama.example.com/v1';
const MODEL_EXAMPLE = 'llama3';

function Toggle({ label, hint, checked, onChange, name, disabled }) {
  const id = useId();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={`${id}-l`}
      aria-describedby={hint ? `${id}-h` : undefined}
      className="mv-setting"
      data-mv-pref={name}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="mv-setting__text">
        <span className="mv-setting__label" id={`${id}-l`}>{label}</span>
        {hint && <span className="mv-setting__hint" id={`${id}-h`}>{hint}</span>}
      </span>
      <span className="mv-switch" aria-hidden="true"><span className="mv-switch__knob" /></span>
    </button>
  );
}

export default function AiSettings() {
  const t = useT();
  const id = useId();
  const prefs = useMobileStore((s) => s.prefs);
  const [failed, setFailed] = useState(false);
  const [hasKey, setHasKey] = useState(null);
  const [key, setKey] = useState('');
  const [keyNote, setKeyNote] = useState(null); // 'saved' | 'removed' | 'failed'
  const [testText, setTestText] = useState(null);
  const test = useAiAction();

  useEffect(() => {
    let live = true;
    daemonCall('mobile.ai.status').then((s) => { if (live) setHasKey(Boolean(s?.hasKey)); }, () => {});
    return () => { live = false; };
  }, []);

  const set = async (patch) => setFailed(!(await useMobileStore.getState().setPrefs(patch)));
  const saveKey = async (value) => {
    try {
      const reply = await daemonCall('mobile.ai.setKey', { key: value });
      setHasKey(Boolean(reply?.hasKey));
      setKey('');
      setKeyNote(value ? 'saved' : 'removed');
    } catch {
      setKeyNote('failed');
    }
  };
  const runTest = () => {
    setTestText(null);
    test.start({ action: 'test' }, setTestText);
  };
  const on = prefs.aiEnabled === true;

  return (
    <>
      <div className="mv-settings__list" data-mv-ai-settings>
        <Toggle name="aiEnabled" label={t('ai.settings.enable')} hint={t('ai.settings.enableHint')} checked={on} onChange={(v) => set({ aiEnabled: v })} />
      </div>
      {on && (
        <>
          <h2 className="mv-settings__heading">{t('ai.settings.provider')}</h2>
          <div className="mv-settings__list">
            <div className="mv-acct-edit">
              <p className="mv-setting__hint mv-acct-edit__title">{t('ai.settings.providerEndpoint')}</p>
              <label className="mv-acct-edit__field" htmlFor={`${id}-url`}>
                <span className="mv-setting__label">{t('ai.settings.endpointUrl')}</span>
                <input
                  id={`${id}-url`}
                  className="mv-setting__input"
                  data-mv-pref="aiEndpointUrl"
                  type="url"
                  inputMode="url"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  maxLength={512}
                  defaultValue={prefs.aiEndpointUrl}
                  placeholder={URL_EXAMPLE}
                  onBlur={(e) => { const v = e.target.value.trim(); if (v !== prefs.aiEndpointUrl) set({ aiEndpointUrl: v }); }}
                />
                <span className="mv-setting__hint">{t('ai.settings.endpointUrlHint')}</span>
              </label>
              <label className="mv-acct-edit__field" htmlFor={`${id}-model`}>
                <span className="mv-setting__label">{t('ai.settings.endpointModel')}</span>
                <input
                  id={`${id}-model`}
                  className="mv-setting__input"
                  data-mv-pref="aiEndpointModel"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  maxLength={200}
                  defaultValue={prefs.aiEndpointModel}
                  placeholder={MODEL_EXAMPLE}
                  onBlur={(e) => { const v = e.target.value.trim(); if (v !== prefs.aiEndpointModel) set({ aiEndpointModel: v }); }}
                />
              </label>
              <label className="mv-acct-edit__field" htmlFor={`${id}-key`}>
                <span className="mv-setting__label">{t('ai.settings.endpointKey')}</span>
                <input
                  id={`${id}-key`}
                  className="mv-setting__input"
                  data-mv-ai-key
                  type="password"
                  autoComplete="off"
                  value={key}
                  onChange={(e) => { setKey(e.target.value); setKeyNote(null); }}
                />
                <span className="mv-setting__hint">{hasKey ? t('ai.settings.keySaved') : t('ai.settings.endpointKeyHint')}</span>
              </label>
              <div className="mv-acct__actions mv-ai__buttons">
                {hasKey && <button type="button" className="mv-textbtn mv-textbtn--danger" data-mv-ai-key-remove onClick={() => saveKey('')}>{t('common.remove')}</button>}
                <button type="button" className="mv-textbtn" data-mv-ai-key-save disabled={!key.trim()} onClick={() => saveKey(key.trim())}>{t('common.save')}</button>
              </div>
              {keyNote === 'failed' && <p className="mv-settings__note mv-settings__note--error" role="alert">{t('mobile.settings.saveFailed')}</p>}
            </div>
            <Toggle
              name="aiSkipPreview"
              label={t('ai.settings.skipPreview')}
              hint={t('ai.settings.skipPreviewHint')}
              checked={prefs.aiSkipPreview === true}
              onChange={(v) => set({ aiSkipPreview: v })}
            />
            <button type="button" className="mv-setting" data-mv-ai-test disabled={test.busy || !prefs.aiEndpointUrl} onClick={runTest}>
              <span className="mv-setting__text">
                <span className="mv-setting__label">{t('ai.settings.sendTest')}</span>
              </span>
            </button>
          </div>
          <p className="mv-settings__note" data-mv-ai-google>{t('mobile.ai.googleNote')}</p>
          {testText != null && <p className="mv-settings__note" role="status" data-mv-ai-test-result dir="auto">{testText}</p>}
          {test.error && <p className="mv-settings__note mv-settings__note--error" role="alert">{t(test.error)}</p>}
        </>
      )}
      {failed && <p className="mv-settings__note mv-settings__note--error" role="alert">{t('mobile.settings.saveFailed')}</p>}
      {test.sheet}
    </>
  );
}
