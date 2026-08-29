import React from 'react';
import { AlertTriangle, ExternalLink } from 'lucide-react';
import { Dialog } from './ui/Dialog';
import { Button } from './ui/Button';
import { t as tr, useT  } from '../i18n/index.js';

export function LinkSafetyModal({ alert, onOpenAnyway, onCancel }) {
  const t = useT();
  const isRed = alert?.level === 'red';
  const iconColor = isRed ? 'text-mail-danger' : 'text-mail-warning';
  const title = isRed ? tr('linkSafety.dangerousLinkDetected') : tr('linkSafety.suspiciousLinkDetected');

  let textDomain = '';
  let actualDomain = '';
  try {
    const text = alert?.textContent || '';
    if (text.includes('://') || text.startsWith('www.')) {
      textDomain = new URL(text.startsWith('www.') ? `https://${text}` : text).hostname;
    }
    actualDomain = new URL(alert.actualUrl).hostname;
  } catch { /* ignore */ }

  return (
    <Dialog
      open={Boolean(alert)}
      onClose={onCancel}
      role="alertdialog"
      closeLabel="Cancel"
      // The hairline carries the severity here: this is the one dialog whose
      // whole job is to say the link is not what it claims to be.
      panelBorder={isRed ? 'border-mail-danger' : 'border-mail-warning'}
      title={title}
      icon={
        <div className={`w-10 h-10 rounded-full ${isRed ? 'bg-mail-danger-tint' : 'bg-mail-warning-tint'} flex items-center justify-center`}>
          <AlertTriangle size={22} className={iconColor} />
        </div>
      }
      description={alert?.reason}
      footer={
        <>
          <Button variant="secondary" size="lg" onClick={onCancel} className="flex-1">
            {t('common.cancel')}
          </Button>
          <Button
            size="lg"
            variant={isRed ? 'dangerTint' : 'secondary'}
            onClick={onOpenAnyway}
            className={`flex-1 ${isRed ? 'border border-mail-danger/30' : 'bg-mail-warning-tint border-mail-warning/30 text-mail-warning hover:bg-mail-warning/20'}`}
          >
            <ExternalLink size={14} />
            {t('linkSafety.openAnyway')}
          </Button>
        </>
      }
    >
      <div className="p-3 rounded-lg bg-mail-surface border border-mail-border">
        <div className="text-xs text-mail-text-muted mb-1">{t('linkSafety.linkTextSays')}</div>
        <div className="text-sm font-mono text-mail-text break-all">{alert?.textContent || '(no text)'}</div>
        {textDomain && <div className="text-xs text-mail-success mt-0.5">{textDomain}</div>}
      </div>

      <div className="p-3 rounded-lg bg-mail-surface border border-mail-border">
        <div className="text-xs text-mail-text-muted mb-1">{t('linkSafety.actuallyRedirects')}</div>
        <div className="text-sm font-mono text-mail-text break-all">{alert?.actualUrl}</div>
        {actualDomain && <div className={`text-xs ${isRed ? 'text-mail-danger' : 'text-mail-warning'} mt-0.5`}>{actualDomain}</div>}
      </div>
    </Dialog>
  );
}
