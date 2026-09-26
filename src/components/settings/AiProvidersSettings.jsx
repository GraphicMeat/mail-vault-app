import React, { useState } from 'react';
import { AlertCircle, CheckCircle2 } from 'lucide-react';
import { useSettingsStore } from '../../stores/settingsStore';

// See aiClient.js's FALLBACK_AI_SETTINGS.
const FALLBACK_AI_SETTINGS = { enabled: false, provider: 'localGguf', endpointUrl: '', endpointModel: '', endpointConsented: false };
import { ToggleSwitch } from '../ui/ToggleSwitch';
import { SettingRow } from '../ui/SettingRow';
import { Button } from '../ui/Button';
import { AiContextPreview } from '../ai/AiContextPreview';
import { currentProvider, listProviders, generate, setEndpointKey } from '../../services/aiClient';
import { useT } from '../../i18n/index.js';
import { SettingsPageLayout } from '../ui/SettingsForm';

const TEST_PROMPT = 'Reply with exactly one short sentence confirming you received this.';

/**
 * Provider selection for every AI feature (Quick Replies, AI Compose). Its
 * own settings section — separate from NotificationSettings.jsx, which
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
      const text = await generate({ prompt: TEST_PROMPT, provider, maxTokens: 60 });
      if (provider.type === 'endpoint') setAiSettings({ endpointConsented: true });
      setTestResult({ ok: true, text });
    } catch (e) {
      setTestResult({ ok: false, text: e?.message || t('ai.settings.checkFailed') });
    } finally {
      setTestBusy(false);
      setPendingTest(false);
    }
  };

  return (
    <SettingsPageLayout>
      <SettingRow
        label={t('ai.settings.enable')}
        description={t('ai.settings.enableHint')}
      >
        <ToggleSwitch
          testId="ai-settings-enable"
          active={aiSettings.enabled}
          onClick={() => setAiSettings({ enabled: !aiSettings.enabled })}
          label={t('ai.settings.enable')}
        />
      </SettingRow>

      {aiSettings.enabled && (
        <>
          <SettingRow label={t('ai.settings.provider')} description={t('ai.settings.providerHint')}>
            <select
              value={aiSettings.provider}
              onChange={e => setAiSettings({ provider: e.target.value })}
              className="w-full px-4 py-2.5 bg-mail-bg border border-mail-border rounded-lg
                        text-mail-text focus:border-mail-accent transition-all cursor-pointer"
            >
              <option value="localGguf">{t('ai.settings.providerLocalGguf')}</option>
              <option value="endpoint">{t('ai.settings.providerEndpoint')}</option>
              <option value="appleFm">{t('ai.settings.providerAppleFm')}</option>
            </select>
          </SettingRow>

          <SettingRow label={t('ai.settings.skipPreview')} description={t('ai.settings.skipPreviewHint')}>
            <ToggleSwitch
              testId="ai-settings-skip-preview"
              active={!!aiSettings.skipPreview}
              onClick={() => setAiSettings({ skipPreview: !aiSettings.skipPreview })}
              label={t('ai.settings.skipPreview')}
            />
          </SettingRow>

          {aiSettings.provider === 'endpoint' && (
            <>
              <SettingRow label={t('ai.settings.endpointUrl')} description={t('ai.settings.endpointUrlHint')}>
                <input
                  type="text"
                  value={aiSettings.endpointUrl}
                  onChange={e => setAiSettings({ endpointUrl: e.target.value })}
                  placeholder="http://localhost:11434/v1"
                  className="settings-input"
                />
              </SettingRow>
              <SettingRow label={t('ai.settings.endpointModel')}>
                <input
                  type="text"
                  value={aiSettings.endpointModel}
                  onChange={e => setAiSettings({ endpointModel: e.target.value })}
                  placeholder="llama3"
                  className="settings-input"
                />
              </SettingRow>
              <SettingRow label={t('ai.settings.endpointKey')} description={t('ai.settings.endpointKeyHint')}>
                <div className="flex gap-2">
                  <input
                    type="password"
                    value={keyInput}
                    onChange={e => { setKeyInput(e.target.value); setKeyStatus(null); }}
                    className="settings-input"
                  />
                  <Button variant="secondary" size="sm" onClick={saveKey} disabled={!keyInput}>{t('common.save')}</Button>
                </div>
              </SettingRow>
              {keyStatus === 'saved' && <p className="text-xs text-mail-accent-text">{t('ai.settings.keySaved')}</p>}
              {keyStatus === 'error' && <p className="text-xs text-mail-danger">{t('ai.settings.checkFailed')}</p>}
            </>
          )}

          <div className="flex items-center gap-3">
            <Button variant="secondary" size="sm" onClick={checkStatus} disabled={checking}>
              {checking ? t('ai.settings.checking') : t('ai.settings.checkStatus')}
            </Button>
            <Button variant="secondary" size="sm" disabled={testBusy}
              onClick={() => (skipPreview ? confirmTest() : setPendingTest(true))}>
              {t('ai.settings.sendTest')}
            </Button>
            {status && (
              status.available
                ? <span className="flex items-center gap-1 text-xs text-mail-accent-text"><CheckCircle2 size={14} />{t('ai.settings.available')}</span>
                : <span className="flex items-center gap-1 text-xs text-mail-danger"><AlertCircle size={14} />{status.reason || t('ai.settings.unavailable')}</span>
            )}
          </div>

          {testResult && (
            <p className={`text-xs ${testResult.ok ? 'text-mail-text-muted' : 'text-mail-danger'}`}>{testResult.text}</p>
          )}
        </>
      )}

      <AiContextPreview
        open={pendingTest}
        text={TEST_PROMPT}
        provider={provider}
        busy={testBusy}
        onCancel={() => setPendingTest(false)}
        onConfirm={confirmTest}
      />
    </SettingsPageLayout>
  );
}
