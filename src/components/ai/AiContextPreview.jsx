import React from 'react';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { t, useT } from '../../i18n/index.js';
import { isNonLocal } from '../../services/aiClient';

/** The URL for an endpoint provider, or the localized "this device" for an on-device one. */
export function destinationLabel(provider) {
  return isNonLocal(provider) ? (provider.url || '') : t('ai.preview.destinationDevice');
}

/**
 * The feature's whole privacy story: shows the EXACT text an AI action is
 * about to send, and names where it goes. Every explicit AI action (Quick
 * Replies never call this — Tier 2 is automatic, see quickReplies.js) routes
 * through here before `aiClient.generate` is ever called.
 *
 * ponytail: confirmation is required on every send, not only "the first" one
 * to a given endpoint — a stricter behaviour than the spec's floor, and a
 * single code path instead of tracking per-destination "already asked"
 * state. `onConfirm` is still the moment `aiSettings.endpointConsented` gets
 * set (by the caller), so Quick Replies' Tier 2 unlocks once real consent
 * has actually happened here.
 */
export function AiContextPreview({ open, text, provider, onConfirm, onCancel, busy = false }) {
  const t = useT();
  if (!open) return null;
  const nonLocal = isNonLocal(provider);

  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={t('ai.preview.title')}
      size="md"
      footer={
        <div className="flex justify-end gap-2 w-full">
          <Button variant="secondary" size="sm" onClick={onCancel} data-autofocus>{t('common.cancel')}</Button>
          <Button variant="primary" size="sm" onClick={onConfirm} disabled={busy} data-testid="ai-preview-confirm">
            {busy ? t('compose.sending') : t('compose.send')}
          </Button>
        </div>
      }
    >
      <div className="space-y-3 text-sm">
        <p className="text-mail-text-muted">
          {t('ai.preview.destination', { destination: destinationLabel(provider, t) })}
        </p>
        {nonLocal && (
          <p className="text-xs text-mail-warning">{t('ai.preview.leavesDevice')}</p>
        )}
        <pre
          data-testid="ai-preview-text"
          className="whitespace-pre-wrap max-h-64 overflow-y-auto rounded-lg border border-mail-border bg-mail-surface p-3 text-xs text-mail-text"
        >
          {text}
        </pre>
      </div>
    </Dialog>
  );
}
