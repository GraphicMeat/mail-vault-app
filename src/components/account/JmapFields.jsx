import React, { useState } from 'react';
import { ChevronRight, ShieldAlert } from 'lucide-react';
import { useT } from '../../i18n/index.js';
import { usePrivateAttr, usePrivateInputClass } from '../../hooks/usePrivacy';

// Shown as an example only, never sent anywhere.
const SESSION_URL_PLACEHOLDER = 'https://jmap.example.com/.well-known/jmap';

/** The JMAP state a form starts from: nothing discovered, Basic sign-in. */
export const EMPTY_JMAP = Object.freeze({
  sessionUrl: '',
  auth: 'basic',
  username: '',
  host: '',
  needsHostConfirmation: false,
  hostConfirmed: false,
  lockedAuth: false,
  // The URL came from a preset or autodetect: Advanced starts closed.
  discovered: false,
});

/**
 * Whether a form may sign in yet: a discovered host off the address's domain
 * must be confirmed first (Task 10's `jmapNeedsHostConfirmation`), because
 * the first request carries the password or token.
 * @param {typeof EMPTY_JMAP} jmap
 */
export function jmapReady(jmap) {
  return !jmap?.needsHostConfirmation || !!jmap.hostConfirmed;
}

/**
 * The JMAP part of the add-account and change-server forms: the token switch,
 * the host confirmation and, under Advanced, the session URL and the Basic
 * login. The password or token field itself stays the form's own.
 *
 * Typing a session URL by hand clears the confirmation: the user has now seen
 * the host the credentials go to.
 */
export function JmapFields({ value, onChange, email = '' }) {
  const t = useT();
  const pa = usePrivateAttr();
  const privateInput = usePrivateInputClass();
  // null until the user opens or closes Advanced: it starts open when there
  // is no discovered URL to show, since then the URL is what they must type.
  const [advancedPick, setAdvanced] = useState(null);
  const advanced = advancedPick ?? !value.discovered;
  const domain = (email.split('@')[1] || '').trim().toLowerCase();
  const basic = value.auth !== 'bearer';
  const inputClass = 'w-full px-3 py-2 bg-mail-bg border border-mail-border rounded-lg text-mail-text placeholder-mail-text-muted text-sm focus:border-mail-accent transition-all';

  return (
    <div className="space-y-3" data-testid="jmap-fields">
      {!value.lockedAuth && (
        <label className="flex items-center gap-2 text-sm text-mail-text cursor-pointer">
          <input
            type="checkbox"
            checked={!basic}
            onChange={e => onChange({ auth: e.target.checked ? 'bearer' : 'basic' })}
          />
          <span>{t('account.jmapUseToken')}</span>
        </label>
      )}

      {value.needsHostConfirmation && (
        <label className="flex items-start gap-2 p-3 rounded-lg bg-mail-warning/10 text-sm text-mail-text cursor-pointer" data-testid="jmap-host-confirm">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={!!value.hostConfirmed}
            onChange={e => onChange({ hostConfirmed: e.target.checked })}
          />
          <ShieldAlert size={16} className="text-mail-warning mt-0.5 flex-shrink-0" aria-hidden="true" />
          <span>{t('account.jmapConfirmHost', { host: value.host, domain: pa(domain, 'email') })}</span>
        </label>
      )}

      <div>
        <button
          type="button"
          onClick={() => setAdvanced(!advanced)}
          aria-expanded={advanced}
          className="text-xs text-mail-text-muted hover:text-mail-text flex items-center gap-1"
        >
          <ChevronRight size={12} className={`transition-transform ${advanced ? 'rotate-90' : ''}`} />
          {t('account.jmapAdvanced')}
        </button>
        {advanced && (
          <div className="mt-2 space-y-3">
            <div>
              <label className="block text-sm text-mail-text-muted mb-1.5">{t('account.jmapSessionUrl')}</label>
              <input
                type="url"
                aria-label={t('account.jmapSessionUrl')}
                value={value.sessionUrl}
                onChange={e => onChange({ sessionUrl: e.target.value, host: '', needsHostConfirmation: false, hostConfirmed: false })}
                placeholder={SESSION_URL_PLACEHOLDER}
                required
                className={inputClass}
              />
            </div>
            {basic && (
              <div>
                <label className="block text-sm text-mail-text-muted mb-1.5">{t('account.jmapUsername')}</label>
                <input
                  type="text"
                  aria-label={t('account.jmapUsername')}
                  value={value.username}
                  onChange={e => onChange({ username: e.target.value })}
                  placeholder={email}
                  autoComplete="username"
                  className={`${privateInput} ${inputClass}`}
                />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
