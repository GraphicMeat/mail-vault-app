import React, { useState } from 'react';
import { Check, AlertTriangle, Send } from 'lucide-react';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import * as api from '../../services/api';
import { ensureFreshToken } from '../../services/authUtils';
import { t, useT  } from '../../i18n/index.js';

/**
 * Verify a send-as address by actually sending a test message from it.
 *
 * There is no way to ask an SMTP server "may I send as X?" without trying —
 * providers only refuse at submission time, and each words it differently
 * (Postfix "Sender address rejected", Fastmail "not owned by", Microsoft
 * "SendAsDenied"). So we send one small message to an address the user picks,
 * defaulting to their own mailbox, and report what the server said.
 *
 * `sentMailbox` is deliberately null — a verification probe must not land in
 * the user's Sent folder.
 */
export function SendAsVerifyModal({ isOpen, account, sendAsAddress, displayName, onClose }) {
  const t = useT();
  const [recipient, setRecipient] = useState(account?.email || '');
  const [status, setStatus] = useState('idle'); // idle | sending | ok | error
  const [message, setMessage] = useState('');

  if (!isOpen) return null;

  const validRecipient = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient.trim());

  const runVerify = async () => {
    setStatus('sending');
    setMessage('');
    try {
      const fresh = await ensureFreshToken(account);
      if (!fresh) throw new Error('Could not refresh account credentials');
      await api.sendEmail(
        { ...fresh, name: displayName || fresh.name || undefined, fromEmail: sendAsAddress },
        {
          to: recipient.trim(),
          subject: t('settings.sendAs.mailvaultSendTest'),
          text: t('settings.sendAs.testMessageSentConfirmMail', { sendAsAddress }),
        },
        null
      );
      setStatus('ok');
      setMessage(t('settings.sendAs.acceptedCheckTestMessage', { account: account.smtpHost || 'The server', sendAsAddress, recipient: recipient.trim() }));
    } catch (err) {
      setStatus('error');
      setMessage(typeof err === 'string' ? err : (err?.message || 'Send failed'));
    }
  };

  return (
    <Dialog
      open={isOpen}
      onClose={onClose}
      data-testid="send-as-verify-modal"
      title={t('settings.sendAs.verifySendAddress')}
      description={
        <>
          {t('settings.sendAs.sendsOneTestMessage')} <span className="font-mono text-mail-text">{sendAsAddress}</span>{' '}
          so you can see whether your server accepts it. Signed in as{' '}
          <span className="font-mono">{account?.email}</span>.
        </>
      }
      footer={
        <div className="flex justify-end gap-2 w-full">
          <Button variant="ghost" onClick={onClose}>{t('common.close')}</Button>
          <Button
            variant="primary"
            onClick={runVerify}
            disabled={!validRecipient}
            loading={status === 'sending'}
            data-testid="send-as-verify-send"
          >
            {status !== 'sending' && <Send size={14} />}
            {status === 'sending' ? t('settings.sendAs.sending') : t('settings.sendAs.sendTest2')}
          </Button>
        </div>
      }
    >
      <div>
          <label className="block text-sm font-medium text-mail-text mb-2">{t('settings.sendAs.sendTest')}</label>
          <input
            type="email"
            value={recipient}
            onChange={(e) => { setRecipient(e.target.value); setStatus('idle'); }}
            placeholder={t('settings.sendAs.exampleCom')}
            data-testid="send-as-verify-recipient"
            className="w-full px-4 py-2.5 bg-mail-bg border border-mail-border rounded-lg
                      text-mail-text placeholder-mail-text-muted focus:border-mail-accent transition-all"
          />

          {status !== 'idle' && status !== 'sending' && (
            <div
              data-testid="send-as-verify-result"
              data-status={status}
              className={`mt-4 flex items-start gap-2 text-sm rounded-lg p-3 ${
                status === 'ok'
                  ? 'bg-mail-success-tint text-mail-success'
                  : 'bg-mail-danger-tint text-mail-danger'
              }`}
            >
              {status === 'ok' ? <Check size={16} className="mt-0.5 shrink-0" /> : <AlertTriangle size={16} className="mt-0.5 shrink-0" />}
              <span className="break-words">{message}</span>
            </div>
          )}

      </div>
    </Dialog>
  );
}
