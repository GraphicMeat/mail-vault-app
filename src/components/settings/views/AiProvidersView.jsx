// Settings > AI providers as a view: Enable AI features, then (while on) the provider, "Skip review
// before sending", the endpoint's URL, model and API key, a status check and a test message.
//
// - `values`: `{ enabled, provider, skipPreview, endpointUrl, endpointModel }`; `onChange(patch)`
//   sets any of them as typed or clicked. `onCommit(key, value)`: called when the URL or model
//   field is left (the phone writes them then; desktop has written them already).
// - `providers`: `[{ value, labelKey }]` for the provider picker; null when the app has one
//   provider (the phone: an OpenAI-compatible endpoint), which is then not a choice.
// - The API key is write-only: `keyInput` / `onKeyInput`, `onSaveKey()`; `keyStatus` 'saved' |
//   'error' | null after a save; `hasKey` (true/false, or null when unknown) and `onRemoveKey()`
//   for an app that can say whether one is stored and drop it.
// - `onCheckStatus()` with `checking` and `status` (`{ available, reason }`): left out when absent.
// - `onSendTest()`, `testBusy`, `testResult` (`{ ok, text }`); `review`: the app's own review of
//   the test before it goes (rendered as given). `googleNote`: the line under the provider.
// - `urlPlaceholder`, `modelPlaceholder`: example values, the same in every language.
import React from 'react';
import { AlertCircle, CheckCircle2 } from 'lucide-react';
import { ToggleSwitch } from '../../ui/ToggleSwitch';
import { SettingRow } from '../../ui/SettingRow';
import { Button } from '../../ui/Button';
import { SettingsCard, SettingsPageLayout } from '../../ui/SettingsForm';
import { useT } from './viewContext';

export function AiProvidersView({
  values, onChange, onCommit, providers = null, googleNote,
  keyInput, onKeyInput, onSaveKey, keyStatus = null, hasKey = null, onRemoveKey,
  onCheckStatus, checking = false, status = null,
  onSendTest, testBusy = false, testDisabled = false, testResult = null, review = null,
  urlPlaceholder, modelPlaceholder, notice = null,
}) {
  const t = useT();
  const endpoint = values.provider === 'endpoint';
  return (
    <SettingsPageLayout>
      <SettingsCard>
      <SettingRow
        label={t('ai.settings.enable')}
        description={t('ai.settings.enableHint')}
      >
        <ToggleSwitch
          testId="ai-settings-enable"
          active={values.enabled}
          onClick={() => onChange({ enabled: !values.enabled })}
          label={t('ai.settings.enable')}
        />
      </SettingRow>

      {values.enabled && (
        <>
          {providers && (
            <SettingRow label={t('ai.settings.provider')} description={t('ai.settings.providerHint')}>
              <select
                value={values.provider}
                onChange={e => onChange({ provider: e.target.value })}
                className="w-full px-4 py-2.5 bg-mail-bg border border-mail-border rounded-lg
                          text-mail-text focus:border-mail-accent transition-all cursor-pointer"
              >
                {providers.map(p => <option key={p.value} value={p.value}>{t(p.labelKey)}</option>)}
              </select>
            </SettingRow>
          )}
          <p className="text-xs text-mail-text-muted" data-testid="ai-settings-google-on-device">{googleNote}</p>

          <SettingRow label={t('ai.settings.skipPreview')} description={t('ai.settings.skipPreviewHint')}>
            <ToggleSwitch
              testId="ai-settings-skip-preview"
              active={!!values.skipPreview}
              onClick={() => onChange({ skipPreview: !values.skipPreview })}
              label={t('ai.settings.skipPreview')}
            />
          </SettingRow>

          {endpoint && (
            <>
              <SettingRow label={t('ai.settings.endpointUrl')} description={t('ai.settings.endpointUrlHint')}>
                <input
                  type="text"
                  aria-label={t('ai.settings.endpointUrl')}
                  value={values.endpointUrl}
                  onChange={e => onChange({ endpointUrl: e.target.value })}
                  onBlur={onCommit && (e => onCommit('endpointUrl', e.target.value))}
                  placeholder={urlPlaceholder}
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  className="settings-input"
                />
              </SettingRow>
              <SettingRow label={t('ai.settings.endpointModel')}>
                <input
                  type="text"
                  aria-label={t('ai.settings.endpointModel')}
                  value={values.endpointModel}
                  onChange={e => onChange({ endpointModel: e.target.value })}
                  onBlur={onCommit && (e => onCommit('endpointModel', e.target.value))}
                  placeholder={modelPlaceholder}
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  className="settings-input"
                />
              </SettingRow>
              <SettingRow label={t('ai.settings.endpointKey')}
                description={hasKey ? t('ai.settings.keySaved') : t('ai.settings.endpointKeyHint')}>
                <div className="flex gap-2">
                  <input
                    type="password"
                    aria-label={t('ai.settings.endpointKey')}
                    autoComplete="off"
                    value={keyInput}
                    onChange={e => onKeyInput(e.target.value)}
                    className="settings-input"
                  />
                  {hasKey && onRemoveKey && <Button variant="secondary" size="sm" onClick={onRemoveKey}>{t('common.remove')}</Button>}
                  <Button variant="secondary" size="sm" onClick={onSaveKey} disabled={!keyInput}>{t('common.save')}</Button>
                </div>
              </SettingRow>
              {keyStatus === 'saved' && <p className="text-xs text-mail-accent-text">{t('ai.settings.keySaved')}</p>}
              {keyStatus === 'error' && <p className="text-xs text-mail-danger">{t('ai.settings.checkFailed')}</p>}
            </>
          )}

          <div className="flex items-center gap-3">
            {onCheckStatus && <Button variant="secondary" size="sm" onClick={onCheckStatus} disabled={checking}>
              {checking ? t('ai.settings.checking') : t('ai.settings.checkStatus')}
            </Button>}
            <Button variant="secondary" size="sm" disabled={testBusy || testDisabled} onClick={onSendTest}>
              {t('ai.settings.sendTest')}
            </Button>
            {status && (
              status.available
                ? <span className="flex items-center gap-1 text-xs text-mail-accent-text"><CheckCircle2 size={14} />{t('ai.settings.available')}</span>
                : <span className="flex items-center gap-1 text-xs text-mail-danger"><AlertCircle size={14} />{status.reason || t('ai.settings.unavailable')}</span>
            )}
          </div>

          {testResult && (
            <p role="status" dir="auto" className={`text-xs ${testResult.ok ? 'text-mail-text-muted' : 'text-mail-danger'}`}>{testResult.text}</p>
          )}
        </>
      )}
      </SettingsCard>

      {notice}
      {review}
    </SettingsPageLayout>
  );
}
