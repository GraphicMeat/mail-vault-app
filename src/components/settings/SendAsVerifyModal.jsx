import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Loader, Check, AlertTriangle, Send } from 'lucide-react';
import * as api from '../../services/api';
import { ensureFreshToken } from '../../services/authUtils';

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
          subject: 'MailVault send-as test',
          text: `This is a test message sent from ${sendAsAddress} to confirm your mail server accepts it as a sender address.`,
        },
        null
      );
      setStatus('ok');
      setMessage(`${account.smtpHost || 'The server'} accepted ${sendAsAddress}. Check ${recipient.trim()} for the test message.`);
    } catch (err) {
      setStatus('error');
      setMessage(typeof err === 'string' ? err : (err?.message || 'Send failed'));
    }
  };

  return (
    <AnimatePresence>
      <div
        className="fixed inset-0 z-[100] flex items-center justify-center p-4"
        onClick={onClose}
        data-testid="send-as-verify-modal"
      >
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        />

        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.95 }}
          className="relative max-w-md w-full bg-mail-bg border border-mail-border rounded-2xl shadow-2xl p-6"
          onClick={e => e.stopPropagation()}
        >
          <button
            onClick={onClose}
            className="absolute top-4 right-4 p-1 rounded-lg hover:bg-mail-surface-hover transition-colors"
            title="Close"
          >
            <X size={18} className="text-mail-text-muted" />
          </button>

          <h3 className="text-lg font-semibold text-mail-text mb-1">Verify send-as address</h3>
          <p className="text-sm text-mail-text-muted mb-4">
            Sends one test message from <span className="font-mono text-mail-text">{sendAsAddress}</span>{' '}
            so you can see whether your server accepts it. Signed in as{' '}
            <span className="font-mono">{account?.email}</span>.
          </p>

          <label className="block text-sm font-medium text-mail-text mb-2">Send test to</label>
          <input
            type="email"
            value={recipient}
            onChange={(e) => { setRecipient(e.target.value); setStatus('idle'); }}
            placeholder="you@example.com"
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
                  ? 'bg-green-500/10 text-green-500'
                  : 'bg-red-500/10 text-red-500'
              }`}
            >
              {status === 'ok' ? <Check size={16} className="mt-0.5 shrink-0" /> : <AlertTriangle size={16} className="mt-0.5 shrink-0" />}
              <span className="break-words">{message}</span>
            </div>
          )}

          <div className="flex justify-end gap-2 mt-5">
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-lg text-sm text-mail-text-muted hover:bg-mail-surface-hover transition-colors"
            >
              Close
            </button>
            <button
              onClick={runVerify}
              disabled={!validRecipient || status === 'sending'}
              data-testid="send-as-verify-send"
              className="px-4 py-2 rounded-lg text-sm bg-mail-accent hover:bg-mail-accent/90 text-white
                        transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {status === 'sending' ? <Loader size={14} className="animate-spin" /> : <Send size={14} />}
              {status === 'sending' ? 'Sending…' : 'Send test'}
            </button>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
}
