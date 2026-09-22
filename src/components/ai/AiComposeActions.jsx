import React, { useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { useSettingsStore } from '../../stores/settingsStore';
import { currentProvider, generate, listProviders } from '../../services/aiClient';
import { AiContextPreview } from './AiContextPreview';
import { useT } from '../../i18n/index.js';

// See aiClient.js's FALLBACK_AI_SETTINGS — some specs mock the whole
// settingsStore module with an object that predates aiSettings.
const FALLBACK_AI_SETTINGS = { enabled: false, provider: 'localGguf', endpointUrl: '', endpointModel: '', endpointConsented: false };

/** One action table feeding one prompt builder and one preview — not five code paths. */
const ACTIONS = {
  draftReply: { labelKey: 'ai.actions.draftReply', source: 'thread' },
  shorten: { labelKey: 'ai.actions.shorten', source: 'draft' },
  tone: { labelKey: 'ai.actions.tone', source: 'draft', tones: ['casual', 'formal', 'friendly'] },
  actionItems: { labelKey: 'ai.actions.actionItems', source: 'thread' },
  summarize: { labelKey: 'ai.actions.summarize', source: 'thread' },
};

function buildPrompt(actionId, text, tone) {
  switch (actionId) {
    case 'draftReply':
      return `Write a short, polite email reply to the message below. Reply with only the message body.\n\n${text}`;
    case 'shorten':
      return `Rewrite the email below to be more concise, keeping its meaning and tone. Reply with only the rewritten text.\n\n${text}`;
    case 'tone':
      return `Rewrite the email below in a more ${tone} tone, keeping its meaning. Reply with only the rewritten text.\n\n${text}`;
    case 'actionItems':
      return `List the action items from the email below as short lines, one per item. If there are none, say so in one line.\n\n${text}`;
    case 'summarize':
      return `Summarize the email thread below in 2-3 short sentences.\n\n${text}`;
    default:
      return text;
  }
}

/**
 * The AI action row for Compose and the viewer (Phase 6). `actions` picks
 * which of the table's entries this surface offers; `getThreadText` /
 * `getDraftText` supply the source text on demand (never eagerly — nothing
 * here reads it until the user clicks); `onResult(actionId, text)` gets the
 * generated text to insert, however the caller's surface wants to use it.
 *
 * Every click always opens `AiContextPreview` first, local providers
 * included ("still show what was used") — see that component for why this
 * is a stricter, single-path version of the spec's "first send" floor.
 */
export function AiComposeActions({ actions = Object.keys(ACTIONS), getThreadText, getDraftText, onResult }) {
  const t = useT();
  // Defensive default: several existing ComposeModal specs stub the whole
  // settingsStore with a hand-built object that predates aiSettings.
  const aiSettings = useSettingsStore(s => s.aiSettings) || FALLBACK_AI_SETTINGS;
  const setAiSettings = useSettingsStore(s => s.setAiSettings) || (() => {});
  const provider = currentProvider(aiSettings);

  // Checked only while AI is on — an install with the feature off (the
  // default) never calls the daemon just because this row is mounted.
  const [available, setAvailable] = useState(null);
  useEffect(() => {
    if (!aiSettings.enabled) { setAvailable(false); return; }
    let cancelled = false;
    listProviders(provider.type === 'endpoint' ? provider.url : undefined)
      .then(list => { if (!cancelled) setAvailable(!!list.find(p => p.provider === provider.type)?.available); })
      .catch(() => { if (!cancelled) setAvailable(false); });
    return () => { cancelled = true; };
  }, [aiSettings.enabled, provider.type, provider.url]);

  const [toneOpenFor, setToneOpenFor] = useState(false);
  const [pending, setPending] = useState(null); // { actionId, tone, text, prompt }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const disabledReason = !aiSettings.enabled
    ? t('ai.actions.disabledOff')
    : available !== true
      ? t('ai.actions.disabledUnavailable')
      : null;

  const start = (actionId, tone) => {
    const cfg = ACTIONS[actionId];
    const text = cfg.source === 'thread' ? getThreadText?.() : getDraftText?.();
    if (!text) return;
    setToneOpenFor(false);
    setError(null);
    setPending({ actionId, tone, text, prompt: buildPrompt(actionId, text, tone) });
  };

  const confirm = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      const result = await generate({ prompt: pending.prompt, provider, maxTokens: 600 });
      // A provider that answers with nothing (or whitespace) must not wipe
      // the draft it was meant to improve — treat it the same as a failure
      // and leave both the draft and the preview alone.
      if (!result?.trim()) { setError(t('ai.actions.generateFailed')); return; }
      if (provider.type === 'endpoint') await setAiSettings({ endpointConsented: true });
      setPending(null);
      onResult(pending.actionId, result);
    } catch {
      setError(t('ai.actions.generateFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="ai-compose-actions">
      <Sparkles size={14} className="text-mail-text-muted" aria-hidden="true" />
      {actions.map(actionId => {
        const cfg = ACTIONS[actionId];
        if (!cfg) return null;
        if (cfg.tones) {
          return (
            <div key={actionId} className="relative">
              <button
                type="button"
                title={disabledReason || undefined}
                disabled={!!disabledReason}
                onClick={() => setToneOpenFor(v => (v === actionId ? false : actionId))}
                className="px-2 py-1 text-xs rounded-md border border-mail-border text-mail-text hover:bg-mail-surface-hover disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {t(cfg.labelKey)}
              </button>
              {toneOpenFor === actionId && (
                <div className="absolute z-10 mt-1 flex flex-col gap-0.5 rounded-md border border-mail-border bg-mail-bg p-1 shadow-lg">
                  {cfg.tones.map(tone => (
                    <button
                      key={tone}
                      type="button"
                      onClick={() => start(actionId, tone)}
                      className="px-2 py-1 text-xs text-left rounded hover:bg-mail-surface-hover text-mail-text whitespace-nowrap"
                    >
                      {t(`ai.actions.tone.${tone}`)}
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        }
        return (
          <button
            key={actionId}
            type="button"
            title={disabledReason || undefined}
            disabled={!!disabledReason}
            onClick={() => start(actionId)}
            className="px-2 py-1 text-xs rounded-md border border-mail-border text-mail-text hover:bg-mail-surface-hover disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {t(cfg.labelKey)}
          </button>
        );
      })}
      {error && <span className="text-xs text-mail-danger">{error}</span>}

      <AiContextPreview
        open={!!pending}
        text={pending?.prompt || ''}
        provider={provider}
        busy={busy}
        onCancel={() => setPending(null)}
        onConfirm={confirm}
      />
    </div>
  );
}
