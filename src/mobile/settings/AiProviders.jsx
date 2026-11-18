// Settings > AI providers on the phone: desktop's AI providers view with the phone's one provider,
// an OpenAI-compatible endpoint (an Ollama or OpenAI-style server); there is no on-device model on
// the phone, so the provider is not a choice here (the engine's `ai.rs` has only the endpoint).
// Enable AI features (`aiEnabled`); the endpoint URL (`aiEndpointUrl`) and model
// (`aiEndpointModel`), written when the field is left, trimmed; the API key, kept in the platform
// secret store by the engine (`mobile.ai.setKey`), never shown again, removable; "Skip review
// before sending" (`aiSkipPreview`); and "Send test message", which goes through the same review as
// every action (AiActions.jsx) and, sent, counts as reviewing this endpoint. Gmail mail never goes
// to a network endpoint (the engine refuses it); the note under the provider says so.
import React, { useEffect, useState } from 'react';
import { AiProvidersView } from '../../components/settings/views/AiProvidersView';
import { useMobileStore } from '../store.js';
import { useT } from '../i18n.js';
import { daemonCall } from '../transport.js';
import { useAiAction } from '../AiActions.jsx';
import { MobileViewEnv, SaveFailed, useSavePrefs } from './MobileViewEnv.jsx';

// Example values, not text: the same in every language.
const URL_EXAMPLE = 'https://ollama.example.com/v1';
const MODEL_EXAMPLE = 'llama3';
const PREF = { enabled: 'aiEnabled', skipPreview: 'aiSkipPreview', endpointUrl: 'aiEndpointUrl', endpointModel: 'aiEndpointModel' };

export default function AiProviders() {
  const t = useT();
  const prefs = useMobileStore((s) => s.prefs);
  const [save, failed] = useSavePrefs();
  // The URL and model as typed, written when their field is left.
  const [draft, setDraft] = useState({});
  const [hasKey, setHasKey] = useState(null);
  const [key, setKey] = useState('');
  const [keyStatus, setKeyStatus] = useState(null); // 'saved' | 'error'
  const [testResult, setTestResult] = useState(null);
  const test = useAiAction();

  useEffect(() => {
    let live = true;
    daemonCall('mobile.ai.status').then((s) => { if (live) setHasKey(Boolean(s?.hasKey)); }, () => {});
    return () => { live = false; };
  }, []);

  const values = {
    enabled: prefs.aiEnabled === true,
    provider: 'endpoint',
    skipPreview: prefs.aiSkipPreview === true,
    endpointUrl: draft.endpointUrl ?? prefs.aiEndpointUrl,
    endpointModel: draft.endpointModel ?? prefs.aiEndpointModel,
  };
  const onChange = (patch) => {
    const typed = {};
    const now = {};
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'endpointUrl' || k === 'endpointModel') typed[k] = v;
      else now[PREF[k]] = v;
    }
    if (Object.keys(typed).length) setDraft((d) => ({ ...d, ...typed }));
    if (Object.keys(now).length) save(now);
  };
  const onCommit = async (k, value) => {
    const v = value.trim();
    if (v !== prefs[PREF[k]]) await save({ [PREF[k]]: v });
    // Saved (or refused): the field shows the stored value again.
    setDraft((d) => ({ ...d, [k]: undefined }));
  };
  const saveKey = async (value) => {
    try {
      const reply = await daemonCall('mobile.ai.setKey', { key: value });
      setHasKey(Boolean(reply?.hasKey));
      setKey('');
      setKeyStatus(value ? 'saved' : null);
    } catch {
      setKeyStatus('error');
    }
  };

  return (
    <MobileViewEnv>
      <AiProvidersView values={values} onChange={onChange} onCommit={onCommit} googleNote={t('mobile.ai.googleNote')}
        keyInput={key} onKeyInput={(v) => { setKey(v); setKeyStatus(null); }} onSaveKey={() => saveKey(key.trim())}
        keyStatus={keyStatus} hasKey={hasKey} onRemoveKey={() => saveKey('')}
        onSendTest={() => { setTestResult(null); test.start({ action: 'test' }, (text) => setTestResult({ ok: true, text })); }}
        testBusy={test.busy} testDisabled={!prefs.aiEndpointUrl} testResult={testResult}
        urlPlaceholder={URL_EXAMPLE} modelPlaceholder={MODEL_EXAMPLE}
        notice={(
          <>
            {test.error && <p className="text-xs text-mail-danger" role="alert">{t(test.error)}</p>}
            <SaveFailed failed={failed} />
          </>
        )}
        review={test.sheet} />
    </MobileViewEnv>
  );
}
