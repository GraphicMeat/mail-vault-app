import React, { useState } from 'react';
import { useSettingsStore } from '../../stores/settingsStore';

// See aiClient.js's FALLBACK_AI_SETTINGS.
const FALLBACK_AI_SETTINGS = { enabled: false, provider: 'localGguf', endpointUrl: '', endpointModel: '', endpointConsented: false };
import { AiContextPreview } from '../ai/AiContextPreview';
import { aiErrorText, currentProvider, listProviders, generate, setEndpointKey } from '../../services/aiClient';
import { useT } from '../../i18n/index.js';
import { DesktopViewEnv } from './DesktopViewEnv';
import { AiProvidersView } from './views/AiProvidersView';

const PROVIDERS = [
  { value: 'localGguf', labelKey: 'ai.settings.providerLocalGguf' },
  { value: 'endpoint', labelKey: 'ai.settings.providerEndpoint' },
  { value: 'appleFm', labelKey: 'ai.settings.providerAppleFm' },
];
const TEST_PROMPT = 'Reply with exactly one short sentence confirming you received this.';

/**
 * Desktop's container: provider selection for every AI feature (Quick
 * Replies, AI Compose) over AiProvidersView. Its own settings section — separate from NotificationSettings.jsx, which
 * other phases own. AI features are OFF by default; nothing here reaches a
 * network until the user turns the switch on AND picks/tests a provider.
 */
export function AiProvidersSettings() {
  const t = useT();
  const aiSettings = useSettingsStore(s => s.aiSettings) || FALLBACK_AI_SETTINGS;
  const setAiSettings = useSettingsStore(s => s.setAiSettings) || (() => {});
  const provider = currentProvider(aiSettings);

  const [keyInput, setKeyInput] = useState('');
  const [keyStatus, setKeyStatus] = useState(null); // 'saved' | 'error' | null
  const [status, setStatus] = useState(null); // { available, reason } | null
  const [checking, setChecking] = useState(false);
  const [pendingTest, setPendingTest] = useState(false);
  const [testBusy, setTestBusy] = useState(false);
  const [testResult, setTestResult] = useState(null); // { ok, text } | null

  const checkStatus = async () => {
    setChecking(true);
    setStatus(null);
    try {
      const list = await listProviders(aiSettings.endpointUrl);
      setStatus(list.find(p => p.provider === provider.type) || null);
    } catch {
      setStatus({ available: false, reason: t('ai.settings.checkFailed') });
    } finally {
      setChecking(false);
    }
  };

  const saveKey = async () => {
    try {
      await setEndpointKey(keyInput);
      setKeyInput('');
      setKeyStatus('saved');
    } catch {
      setKeyStatus('error');
    }
  };

  // Same rule as AiComposeActions: an endpoint never consented to still asks once.
  const skipPreview = !!aiSettings.skipPreview && (provider.type !== 'endpoint' || aiSettings.endpointConsented);

  const confirmTest = async () => {
    setTestBusy(true);
    try {
      const text = await generate({ prompt: TEST_PROMPT, provider, maxTokens: 60, noMailContent: true });
      if (provider.type === 'endpoint') setAiSettings({ endpointConsented: true });
      setTestResult({ ok: true, text });
    } catch (e) {
      setTestResult({ ok: false, text: aiErrorText(e, t, e?.message || t('ai.settings.checkFailed')) });
    } finally {
      setTestBusy(false);
      setPendingTest(false);
    }
  };

  return (
    <DesktopViewEnv>
      <AiProvidersView values={aiSettings} onChange={setAiSettings} providers={PROVIDERS}
        googleNote={t('ai.settings.googleOnDevice')}
        keyInput={keyInput} onKeyInput={value => { setKeyInput(value); setKeyStatus(null); }} onSaveKey={saveKey} keyStatus={keyStatus}
        onCheckStatus={checkStatus} checking={checking} status={status}
        onSendTest={() => (skipPreview ? confirmTest() : setPendingTest(true))} testBusy={testBusy} testResult={testResult}
        urlPlaceholder="http://localhost:11434/v1" modelPlaceholder="llama3"
        review={<AiContextPreview
          open={pendingTest}
          text={TEST_PROMPT}
          provider={provider}
          busy={testBusy}
          onCancel={() => setPendingTest(false)}
          onConfirm={confirmTest}
        />} />
    </DesktopViewEnv>
  );
}
