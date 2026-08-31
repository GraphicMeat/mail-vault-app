import React, { useState, useRef, useEffect, useId } from 'react';
import { useAccountStore } from '../stores/accountStore';
import { Dialog } from './ui/Dialog';
import { Button } from './ui/Button';
import { getOAuth2AuthUrl, exchangeOAuth2Code, testConnection, resolveEmailSettings } from '../services/api';
import { isPersonalMicrosoftEmail } from '../services/graphConfig';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Mail, Lock, Server, Eye, EyeOff, Check, AlertCircle, Loader, Wand2, Shield, ChevronRight } from 'lucide-react';
import { describeConnectionError } from '../utils/connectionError';
import { t as tr, t, useT   } from '../i18n/index.js';

// Common email provider configurations
export const PROVIDER_CONFIGS = () => ({
  gmail: {
    name: 'Gmail',
    domains: ['gmail.com', 'googlemail.com'],
    imapHost: 'imap.gmail.com',
    imapPort: 993,
    smtpHost: 'smtp.gmail.com',
    smtpPort: 587,
    note: tr('account.signGoogleAccount'),
    supportsOAuth2: true,
    oauth2Provider: 'google'
  },
  outlook: {
    name: tr('account.outlookMicrosoft365'),
    domains: ['outlook.com', 'hotmail.com', 'live.com', 'msn.com'],
    imapHost: 'outlook.office365.com',
    imapPort: 993,
    smtpHost: 'smtp.office365.com',
    smtpPort: 587,
    note: tr('account.signMicrosoftAccount'),
    supportsOAuth2: true,
    oauth2Provider: 'microsoft'
  },
  yahoo: {
    name: tr('account.yahooMail'),
    domains: ['yahoo.com', 'yahoo.co.uk', 'yahoo.co.jp', 'yahoo.fr', 'yahoo.de', 'yahoo.it', 'yahoo.es', 'yahoo.com.br', 'yahoo.com.au', 'yahoo.ca', 'yahoo.in', 'ymail.com', 'rocketmail.com', 'myyahoo.com'],
    imapHost: 'imap.mail.yahoo.com',
    imapPort: 993,
    smtpHost: 'smtp.mail.yahoo.com',
    smtpPort: 587,
    note: tr('account.yahooRequiresAppPassword'),
    helpUrl: 'https://login.yahoo.com/myc/security/app-passwords',
    helpLabel: tr('account.generateAppPassword')
  },
  icloud: {
    name: 'iCloud Mail',
    domains: ['icloud.com', 'me.com', 'mac.com'],
    imapHost: 'imap.mail.me.com',
    imapPort: 993,
    smtpHost: 'smtp.mail.me.com',
    smtpPort: 587,
    note: 'iCloud requires an App-Specific Password',
    helpUrl: 'https://support.apple.com/en-us/102654',
    helpLabel: tr('account.generateAppSpecificPassword')
  },
  aol: {
    name: tr('account.aolMail'),
    domains: ['aol.com'],
    imapHost: 'imap.aol.com',
    imapPort: 993,
    smtpHost: 'smtp.aol.com',
    smtpPort: 587,
    note: tr('account.aolRequiresAppPassword'),
    helpUrl: 'https://help.aol.com/articles/Create-and-manage-app-password',
    helpLabel: tr('account.generateAppPassword')
  },
  zoho: {
    name: tr('account.zohoMail'),
    domains: ['zoho.com', 'zohomail.com'],
    imapHost: 'imap.zoho.com',
    imapPort: 993,
    smtpHost: 'smtp.zoho.com',
    smtpPort: 587,
    note: tr('account.enableImapZohoSettings')
  },
  protonmail: {
    name: 'Proton Mail Bridge',
    domains: ['protonmail.com', 'proton.me', 'pm.me'],
    imapHost: '127.0.0.1',
    imapPort: 1143,
    imapSecurity: 'starttls',
    smtpHost: '127.0.0.1',
    smtpPort: 1025,
    note: tr('account.mailvaultConnectsThroughProtonMail'),
    helpUrl: 'https://mailvaultapp.com/faq.html#proton-mail-bridge',
    helpLabel: tr('account.setupGuide')
  },
  fastmail: {
    name: 'Fastmail',
    domains: ['fastmail.com', 'fastmail.fm'],
    imapHost: 'imap.fastmail.com',
    imapPort: 993,
    smtpHost: 'smtp.fastmail.com',
    smtpPort: 587,
    note: tr('account.useAppPasswordSignFastmail')
  }
});

// Try to detect provider from email domain
export function detectProvider(email) {
  const domain = email.split('@')[1]?.toLowerCase();
  if (!domain) return null;

  for (const [key, config] of Object.entries(PROVIDER_CONFIGS())) {
    if (config.domains?.includes(domain)) {
      return { key, config };
    }
  }

  return null;
}

// Fastmail signs in with the @fastmail.com address and sends from aliases,
// so its forms call the field what it is. Matched on the IMAP host (shared
// by custom-domain logins); the domain check covers the add form before a
// host is filled in.
export function isFastmailAccount({ email = '', imapHost = '' } = {}) {
  return /(^|\.)fastmail\.com$/i.test(imapHost) || detectProvider(email)?.key === 'fastmail';
}

// Try common server patterns for unknown domains
function guessServerSettings(email) {
  const domain = email.split('@')[1]?.toLowerCase();
  if (!domain) return null;

  return {
    // Common patterns for custom domains
    patterns: [
      { imapHost: `imap.${domain}`, smtpHost: `smtp.${domain}` },
      { imapHost: `mail.${domain}`, smtpHost: `mail.${domain}` },
      { imapHost: domain, smtpHost: domain }
    ],
    imapPort: 993,
    smtpPort: 587
  };
}

export function AccountModal({ onClose, onSuccess }) {
  const t = useT();
  const titleId = useId();
  const { addAccount } = useAccountStore();

  const [step, setStep] = useState(1);
  const [provider, setProvider] = useState(null);
  const [showPassword, setShowPassword] = useState(false);
  const [testing, setTesting] = useState(false);
  const [autoDetecting, setAutoDetecting] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(false);
  const [detectedProvider, setDetectedProvider] = useState(null);
  const [showManualConfig, setShowManualConfig] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  // OAuth2 state
  const [authType, setAuthType] = useState('password'); // 'password' | 'oauth2'
  const [oauthLoading, setOauthLoading] = useState(false);
  const [oauthConnected, setOauthConnected] = useState(false);
  const oauthAbortRef = useRef(null);

  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);

  const [formData, setFormData] = useState({
    name: '',
    email: '',
    password: '',
    imapHost: '',
    imapPort: 993,
    imapSecure: true,
    imapSecurity: 'ssl',
    smtpHost: '',
    smtpPort: 587,
    smtpSecure: false,
    // OAuth2 fields
    authType: 'password',
    oauth2Provider: null,
    oauth2RefreshToken: '',
    oauth2AccessToken: '',
    oauth2ExpiresAt: null,
    oauth2CustomClientId: '',
    oauth2TenantId: '',
    oauth2Transport: ''
  });

  const isDirty = () => {
    if (step === 1) return false;
    return !!(
      formData.email.trim() ||
      formData.name.trim() ||
      formData.password.trim() ||
      oauthConnected
    );
  };


  const handleClose = () => {
    if (isDirty()) {
      setShowDiscardConfirm(true);
    } else {
      onClose();
    }
  };

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        handleClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  });

  const handleProviderSelect = (key) => {
    const config = key === 'custom'
      ? { imapHost: '', imapPort: 993, smtpHost: '', smtpPort: 587 }
      : PROVIDER_CONFIGS()[key];

    setProvider(key);
    setFormData(prev => ({
      ...prev,
      imapHost: config.imapHost,
      imapPort: config.imapPort,
      imapSecurity: config.imapSecurity || 'ssl',
      smtpHost: config.smtpHost,
      smtpPort: config.smtpPort
    }));

    // Reset auth type when selecting a new provider
    if (config.supportsOAuth2) {
      setAuthType('oauth2');
    } else {
      setAuthType('password');
    }

    if (key === 'custom') {
      setShowManualConfig(false);
    }

    setStep(2);
  };

  const handleInputChange = (e) => {
    const { name, value, type, checked } = e.target;
    // Ports must stay numbers: the Rust side takes u16, so a typed-in port
    // arriving as a string fails the connection test before it ever dials.
    // An empty field falls back to the provider default rather than 0.
    const parse = () => {
      if (type === 'checkbox') return checked;
      if (type === 'number') return value === '' ? undefined : Number(value);
      return value;
    };
    setFormData(prev => ({
      ...prev,
      [name]: parse()
    }));
    setError(null);

    // Auto-detect provider when email changes
    if (name === 'email' && value.includes('@')) {
      const detected = detectProvider(value);
      setDetectedProvider(detected);
    }
  };

  // ssl -> starttls/none moves the default IMAP port from 993 to 143 (and back).
  // Only follow that default if the user hasn't typed a custom port already.
  const SECURITY_DEFAULT_PORTS = { ssl: 993, starttls: 143, none: 143 };
  const handleSecurityChange = (e) => {
    const nextSecurity = e.target.value;
    setFormData(prev => {
      const prevDefaultPort = SECURITY_DEFAULT_PORTS[prev.imapSecurity] ?? 993;
      const portIsDefault = Number(prev.imapPort) === prevDefaultPort;
      return {
        ...prev,
        imapSecurity: nextSecurity,
        imapPort: portIsDefault ? SECURITY_DEFAULT_PORTS[nextSecurity] : prev.imapPort
      };
    });
  };

  const handleAutoDetect = async () => {
    console.log('[AccountModal] handleAutoDetect called');
    if (!formData.email || !formData.password) {
      setError(t('account.enterEmailAddressPasswordFirst'));
      return;
    }

    setAutoDetecting(true);
    setError(null);

    // First check if we know this provider
    const detected = detectProvider(formData.email);
    console.log('[AccountModal] detectProvider result:', detected?.key || 'none');
    if (detected) {
      setFormData(prev => ({
        ...prev,
        imapHost: detected.config.imapHost,
        imapPort: detected.config.imapPort,
        smtpHost: detected.config.smtpHost,
        smtpPort: detected.config.smtpPort
      }));
      setDetectedProvider(detected);
      setAutoDetecting(false);
      return;
    }

    // Try DNS-based detection (SRV, autoconfig, MX)
    try {
      const domain = formData.email.split('@')[1]?.toLowerCase();
      if (domain) {
        console.log('[AccountModal] Trying DNS resolution for %s', domain);
        const dnsResult = await resolveEmailSettings(domain);
        if (dnsResult && (dnsResult.imapHost || dnsResult.smtpHost)) {
          console.log('[AccountModal] DNS resolved: %s (source: %s)', dnsResult.imapHost, dnsResult.source);
          setFormData(prev => ({
            ...prev,
            imapHost: dnsResult.imapHost || prev.imapHost,
            imapPort: dnsResult.imapPort || prev.imapPort,
            smtpHost: dnsResult.smtpHost || prev.smtpHost,
            smtpPort: dnsResult.smtpPort || prev.smtpPort,
          }));
          setDetectedProvider({ key: 'custom', config: { name: dnsResult.provider || domain } });
          setAutoDetecting(false);
          return;
        }
      }
    } catch (e) {
      console.log('[AccountModal] DNS resolution failed, falling back to pattern guessing: %s', e.message);
    }

    // Try common patterns by actually testing connections
    const guess = guessServerSettings(formData.email);
    if (guess) {
      let foundWorking = false;

      for (const pattern of guess.patterns) {
        try {
          const testAccount = {
            email: formData.email,
            password: formData.password,
            imapHost: pattern.imapHost,
            imapPort: guess.imapPort,
            imapSecure: true,
            smtpHost: pattern.smtpHost,
            smtpPort: guess.smtpPort,
            smtpSecure: false
          };

          // Actually test the connection
          console.log('[AccountModal] Testing pattern: %s:%d', pattern.imapHost, guess.imapPort);
          const result = await testConnection(testAccount);
          console.log('[AccountModal] Pattern result:', result.success ? 'SUCCESS' : 'FAILED');

          if (result.success) {
            setFormData(prev => ({
              ...prev,
              imapHost: pattern.imapHost,
              imapPort: guess.imapPort,
              smtpHost: pattern.smtpHost,
              smtpPort: guess.smtpPort
            }));
            setDetectedProvider({
              key: 'auto',
              config: {
                name: t('account.autoDetected', { pattern: pattern.imapHost }),
                ...pattern,
                imapPort: guess.imapPort,
                smtpPort: guess.smtpPort
              }
            });
            foundWorking = true;
            break;
          }
        } catch (e) {
          console.log('[AccountModal] Pattern %s failed: %s', pattern.imapHost, e.message);
          // Connection failed, try next pattern
          continue;
        }
      }

      if (!foundWorking) {
        // No pattern worked, show manual config with first guess
        setFormData(prev => ({
          ...prev,
          imapHost: guess.patterns[0].imapHost,
          imapPort: guess.imapPort,
          smtpHost: guess.patterns[0].smtpHost,
          smtpPort: guess.smtpPort
        }));
        setError(t('account.noSettingsFoundDomainProvider'));
      }

      setShowManualConfig(true);
    }

    setAutoDetecting(false);
  };

  const handleOAuth2SignIn = async () => {
    setOauthLoading(true);
    setError(null);

    // Create an abort signal so the user can cancel the waiting state
    let cancelled = false;
    oauthAbortRef.current = () => { cancelled = true; };

    // Capture the email before async operations (user may have typed it)
    const userEnteredEmail = formData.email;

    const currentProvider = providerConfig?.oauth2Provider || 'microsoft';

    // Detect personal Microsoft accounts — these need Graph API scopes (IMAP OAuth broken)
    const isPersonalMs = currentProvider === 'microsoft' && isPersonalMicrosoftEmail(userEnteredEmail);

    try {
      // Step 1: Get the auth URL from the server (pass email as login_hint + provider)
      const { authUrl, state } = await getOAuth2AuthUrl(
        userEnteredEmail,
        currentProvider,
        formData.oauth2CustomClientId || undefined,
        formData.oauth2TenantId || undefined,
        isPersonalMs
      );

      // Step 2: Open the auth URL in the default browser
      if (window.__TAURI__) {
        const { open } = await import('@tauri-apps/plugin-shell');
        await open(authUrl);
      } else {
        window.open(authUrl, '_blank');
      }

      // Step 3: Wait for the callback — exchange endpoint blocks until user completes sign-in
      const tokenData = await exchangeOAuth2Code(state);

      if (cancelled) return; // User cancelled while waiting

      // Step 4: Update form data with OAuth2 tokens
      // Email must be entered manually by the user (no OpenID scopes = no email from token)
      setFormData(prev => ({
        ...prev,
        authType: 'oauth2',
        oauth2Provider: currentProvider,
        oauth2AccessToken: tokenData.accessToken,
        oauth2RefreshToken: tokenData.refreshToken,
        oauth2ExpiresAt: tokenData.expiresAt,
        oauth2Transport: isPersonalMs ? 'graph' : 'imap',
        password: '' // Clear password — not needed for OAuth2
      }));

      setOauthConnected(true);
    } catch (err) {
      if (cancelled) return; // User cancelled — don't show error
      console.error('[AccountModal] OAuth2 sign-in failed:', err);
      const providerLabel = { google: 'Google', microsoft: 'Microsoft', yahoo: 'Yahoo' }[currentProvider] || 'provider';
      setError(err.message || `${providerLabel} sign-in failed. Please try again.`);
    } finally {
      if (!cancelled) setOauthLoading(false);
      oauthAbortRef.current = null;
    }
  };

  const handleOAuth2Cancel = () => {
    if (oauthAbortRef.current) oauthAbortRef.current();
    setOauthLoading(false);
    setError(null);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    console.log('[AccountModal] handleSubmit called');
    setError(null);
    setTesting(true);

    try {
      const accountData = { ...formData };

      // Set the auth type properly
      if (authType === 'oauth2') {
        accountData.authType = 'oauth2';
        accountData.oauth2Provider = providerConfig?.oauth2Provider || 'microsoft';
      } else {
        accountData.authType = 'password';
      }

      console.log('[AccountModal] Calling addAccount with:', {
        email: accountData.email,
        imapHost: accountData.imapHost,
        imapPort: accountData.imapPort,
        authType: accountData.authType || 'password'
      });
      await addAccount(accountData);
      console.log('[AccountModal] addAccount completed successfully');
      setSuccess(true);
      setTimeout(() => {
        // A caller that wants to know the account actually landed passes
        // onSuccess; everyone else keeps the old close-only behaviour.
        if (onSuccess) onSuccess();
        else onClose();
      }, 1500);
    } catch (err) {
      console.error('[AccountModal] addAccount failed:', err);
      // Never the raw backend string as the whole message: this is the first
      // thing someone sees when setup fails, and "Connection test failed:
      // AUTHENTICATIONFAILED (Failure)" names no problem they can act on.
      setError(describeConnectionError(err));
    } finally {
      setTesting(false);
    }
  };

  const providerConfig = provider && PROVIDER_CONFIGS()[provider];
  const showOAuth2Option = providerConfig?.supportsOAuth2;
  const isFastmail = provider === 'fastmail' || isFastmailAccount(formData);

  return (
    <Dialog
      open
      onClose={handleClose}
      size="lg"
      padded={false}
      panelBg="bg-mail-surface"
      aria-labelledby={titleId}
      panelClassName="overflow-hidden max-h-[90vh] flex flex-col"
    >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-mail-border">
          <h2 id={titleId} className="text-lg font-semibold text-mail-text">
            {step === 1 ? t('account.chooseEmailProvider') : t('settings.accounts.addAccount')}
          </h2>
          <Button variant="ghost" icon size="xs" onClick={handleClose} aria-label={t('common.close')}>
            <X size={20} />
          </Button>
        </div>

        {/* Content */}
        <div className="p-6 overflow-y-auto">
          {step === 1 ? (
            <div className="grid grid-cols-2 gap-2">
              {Object.entries(PROVIDER_CONFIGS()).map(([key, config]) => (
                <button
                  key={key}
                  onClick={() => handleProviderSelect(key)}
                  className="flex items-center gap-3 p-3 rounded-xl border border-mail-border
                            hover:border-mail-accent/50 hover:bg-mail-surface-hover
                            transition-all text-left group"
                >
                  <div className="w-9 h-9 flex-shrink-0 bg-mail-accent/10 rounded-lg flex items-center
                                justify-center group-hover:bg-mail-accent/20 transition-colors">
                    <Mail size={18} className="text-mail-accent-text" />
                  </div>
                  <div className="min-w-0">
                    <div className="font-medium text-mail-text text-sm truncate">{config.name}</div>
                    <div className="text-xs text-mail-text-muted truncate">{config.imapHost}</div>
                  </div>
                </button>
              ))}

              <button
                onClick={() => handleProviderSelect('custom')}
                className="flex items-center gap-3 p-3 rounded-xl border border-mail-border
                          hover:border-mail-accent/50 hover:bg-mail-surface-hover
                          transition-all text-left group"
              >
                <div className="w-9 h-9 flex-shrink-0 bg-mail-accent/10 rounded-lg flex items-center
                              justify-center group-hover:bg-mail-accent/20 transition-colors">
                  <Server size={18} className="text-mail-accent-text" />
                </div>
                <div className="min-w-0">
                  <div className="font-medium text-mail-text text-sm truncate">Other / Custom</div>
                  <div className="text-xs text-mail-text-muted truncate">{t('account.autoDetectManualConfig')}</div>
                </div>
              </button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              {/* Provider Note */}
              {provider && providerConfig?.note && (
                <div className="flex items-start gap-3 p-3 bg-mail-accent/10 rounded-lg text-sm">
                  <AlertCircle size={16} className="text-mail-accent-text mt-0.5 flex-shrink-0" />
                  <div className="text-mail-text">
                    <span>{providerConfig.note}</span>
                    {providerConfig.helpUrl && (
                      <button
                        type="button"
                        className="ml-2 text-mail-accent-text hover:underline font-medium"
                        onClick={() => {
                          import('@tauri-apps/plugin-shell').then(({ open }) => {
                            open(providerConfig.helpUrl);
                          }).catch(() => {
                            window.open(providerConfig.helpUrl, '_blank');
                          });
                        }}
                      >
                        {providerConfig.helpLabel || 'Learn more'} &rarr;
                      </button>
                    )}
                  </div>
                </div>
              )}

              {/* Detected Provider Note */}
              {provider === 'custom' && detectedProvider && (
                <div className="flex items-start gap-3 p-3 bg-mail-success/10 rounded-lg text-sm">
                  <Check size={16} className="text-mail-success mt-0.5 flex-shrink-0" />
                  <span className="text-mail-text">
                    Detected: {detectedProvider.config.name}. Settings auto-filled.
                  </span>
                </div>
              )}

              {/* Email — shown first for OAuth2 so user enters it before sign-in */}
              {showOAuth2Option && authType === 'oauth2' && (
                <div>
                  <label className="block text-sm text-mail-text-muted mb-1.5">
                    Email Address *
                  </label>
                  <div className="relative">
                    <Mail size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-mail-text-muted" />
                    <input
                      type="email"
                      name="email"
                      value={formData.email}
                      onChange={handleInputChange}
                      placeholder={t('account.outlookCom')}
                      required
                      className="w-full pl-10 pr-4 py-2.5 bg-mail-bg border border-mail-border rounded-lg
                                text-mail-text placeholder-mail-text-muted
                                focus:border-mail-accent focus:ring-1 focus:ring-mail-accent
                                transition-all"
                    />
                  </div>
                </div>
              )}

              {/* OAuth2 vs Password selector for supported providers */}
              {showOAuth2Option && (
                <div className="space-y-3">
                  {/* Sign in with Microsoft button */}
                  {authType === 'oauth2' && !oauthConnected && (
                    <>
                      <button
                        type="button"
                        onClick={handleOAuth2SignIn}
                        disabled={oauthLoading || !formData.email?.includes('@')}
                        className={`w-full flex items-center justify-center gap-3 px-4 py-3
                                  text-white rounded-lg transition-all font-medium
                                  ${oauthLoading || !formData.email?.includes('@')
                                    ? 'bg-mail-accent-fill/50 cursor-not-allowed'
                                    : 'bg-mail-accent-fill hover:bg-mail-accent-hover'}`}
                      >
                        {oauthLoading ? (
                          <>
                            <Loader size={18} className="animate-spin" />
                            Waiting for {({ google: 'Google', microsoft: 'Microsoft', yahoo: 'Yahoo' }[providerConfig?.oauth2Provider] || providerConfig?.name || 'provider')} sign-in...
                          </>
                        ) : (
                          <>
                            <Shield size={18} />
                            Sign in with {({ google: 'Google', microsoft: 'Microsoft', yahoo: 'Yahoo' }[providerConfig?.oauth2Provider] || providerConfig?.name || 'provider')}
                          </>
                        )}
                      </button>
                      {oauthLoading && (
                        <button
                          type="button"
                          onClick={handleOAuth2Cancel}
                          className="w-full text-sm text-mail-text-muted hover:text-mail-text
                                     py-1.5 transition-colors"
                        >
                          {t('common.cancel')}
                        </button>
                      )}
                    </>
                  )}

                  {/* Advanced (Corporate) section for Microsoft OAuth2 */}
                  {authType === 'oauth2' && providerConfig?.oauth2Provider === 'microsoft' && (
                    <div className="mt-2">
                      <button
                        type="button"
                        onClick={() => setShowAdvanced(!showAdvanced)}
                        className="text-xs text-mail-text-muted hover:text-mail-text flex items-center gap-1"
                      >
                        <ChevronRight size={12} className={`transition-transform ${showAdvanced ? 'rotate-90' : ''}`} />
                        Advanced (Corporate)
                      </button>
                      {showAdvanced && (
                        <div className="mt-2 space-y-2">
                          <input
                            type="text"
                            placeholder={t('account.customClientIdOptional')}
                            value={formData.oauth2CustomClientId}
                            onChange={e => setFormData(prev => ({ ...prev, oauth2CustomClientId: e.target.value }))}
                            className="w-full px-3 py-1.5 text-xs bg-mail-bg border border-mail-border rounded text-mail-text placeholder-mail-text-muted"
                          />
                          <input
                            type="text"
                            placeholder={t('account.tenantIdOptionalEG')}
                            value={formData.oauth2TenantId}
                            onChange={e => setFormData(prev => ({ ...prev, oauth2TenantId: e.target.value }))}
                            className="w-full px-3 py-1.5 text-xs bg-mail-bg border border-mail-border rounded text-mail-text placeholder-mail-text-muted"
                          />
                        </div>
                      )}
                    </div>
                  )}

                  {/* OAuth2 connected state */}
                  {oauthConnected && (
                    <div className="flex items-center gap-3 p-3 bg-mail-success/10 border border-mail-success/20 rounded-lg text-sm">
                      <Check size={16} className="text-mail-success flex-shrink-0" />
                      <div>
                        <span className="text-mail-text font-medium">{({ google: 'Google', microsoft: 'Microsoft', yahoo: 'Yahoo' }[providerConfig?.oauth2Provider] || providerConfig?.name || 'provider')} account connected</span>
                        {formData.email && (
                          <span className="text-mail-text-muted ml-1">({formData.email})</span>
                        )}
                      </div>
                    </div>
                  )}

                </div>
              )}

              {/* Display Name — always shown */}
              <div>
                <label className="block text-sm text-mail-text-muted mb-1.5">
                  Display Name (optional)
                </label>
                <input
                  type="text"
                  name="name"
                  value={formData.name}
                  onChange={handleInputChange}
                  placeholder={t('account.johnDoe')}
                  className="w-full px-4 py-2.5 bg-mail-bg border border-mail-border rounded-lg
                            text-mail-text placeholder-mail-text-muted
                            focus:border-mail-accent focus:ring-1 focus:ring-mail-accent
                            transition-all"
                />
              </div>

              {/* Email — for non-OAuth2 flows (password auth or non-Outlook providers) */}
              {!(showOAuth2Option && authType === 'oauth2') && (
                <div>
                  <label className="block text-sm text-mail-text-muted mb-1.5">
                    {isFastmail ? t('account.loginAddress') : t('account.emailAddress')} *
                  </label>
                  <div className="relative">
                    <Mail size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-mail-text-muted" />
                    <input
                      type="email"
                      name="email"
                      value={formData.email}
                      onChange={handleInputChange}
                      placeholder={isFastmail ? 'you@fastmail.com' : 'you@example.com'}
                      required
                      className="w-full pl-10 pr-4 py-2.5 bg-mail-bg border border-mail-border rounded-lg
                                text-mail-text placeholder-mail-text-muted
                                focus:border-mail-accent focus:ring-1 focus:ring-mail-accent
                                transition-all"
                    />
                  </div>
                </div>
              )}

              {/* Password — only show for password auth */}
              {authType === 'password' && (
                <div>
                  <label className="block text-sm text-mail-text-muted mb-1.5">
                    Password *
                  </label>
                  <div className="relative">
                    <Lock size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-mail-text-muted" />
                    <input
                      type={showPassword ? 'text' : 'password'}
                      name="password"
                      value={formData.password}
                      onChange={handleInputChange}
                      placeholder="••••••••••••"
                      required={authType === 'password'}
                      className="w-full pl-10 pr-12 py-2.5 bg-mail-bg border border-mail-border rounded-lg
                                text-mail-text placeholder-mail-text-muted
                                focus:border-mail-accent focus:ring-1 focus:ring-mail-accent
                                transition-all"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-mail-text-muted
                                hover:text-mail-text transition-colors"
                    >
                      {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                    </button>
                  </div>
                </div>
              )}

              {/* Auto-detect button for custom provider */}
              {provider === 'custom' && !showManualConfig && (
                <button
                  type="button"
                  onClick={handleAutoDetect}
                  disabled={autoDetecting || !formData.email}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2.5
                            bg-mail-surface-hover hover:bg-mail-border
                            text-mail-text rounded-lg transition-all disabled:opacity-50"
                >
                  {autoDetecting ? (
                    <>
                      <Loader size={18} className="animate-spin" />
                      {t('account.detectingSettings')}
                    </>
                  ) : (
                    <>
                      <Wand2 size={18} />
                      {t('account.autoDetectServerSettings')}
                    </>
                  )}
                </button>
              )}

              {/* Server Settings (for custom provider or after auto-detect) */}
              {(provider === 'custom' && (showManualConfig || detectedProvider)) && (
                <>
                  <div className="border-t border-mail-border pt-4 mt-4">
                    <h3 className="text-sm font-medium text-mail-text mb-3 flex items-center gap-2">
                      <Server size={16} />
                      {t('account.serverSettings')}
                    </h3>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-sm text-mail-text-muted mb-1.5">
                        IMAP Host *
                      </label>
                      <input
                        type="text"
                        name="imapHost"
                        value={formData.imapHost}
                        onChange={handleInputChange}
                        placeholder={t('account.imapExampleCom')}
                        required
                        className="w-full px-3 py-2 bg-mail-bg border border-mail-border rounded-lg
                                  text-mail-text placeholder-mail-text-muted text-sm
                                  focus:border-mail-accent transition-all"
                      />
                    </div>
                    <div>
                      <label className="block text-sm text-mail-text-muted mb-1.5">
                        {t('account.imapPort')}
                      </label>
                      <input
                        type="number"
                        name="imapPort"
                        value={formData.imapPort}
                        onChange={handleInputChange}
                        className="w-full px-3 py-2 bg-mail-bg border border-mail-border rounded-lg
                                  text-mail-text text-sm focus:border-mail-accent transition-all"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm text-mail-text-muted mb-1.5">
                      {t('account.security')}
                    </label>
                    <select
                      name="imapSecurity"
                      value={formData.imapSecurity}
                      onChange={handleSecurityChange}
                      className="w-full px-3 py-2 bg-mail-bg border border-mail-border rounded-lg
                                text-mail-text text-sm focus:border-mail-accent transition-all"
                    >
                      <option value="ssl">SSL/TLS</option>
                      <option value="starttls">{t('account.starttls')}</option>
                      <option value="none">{t('account.none')}</option>
                    </select>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-sm text-mail-text-muted mb-1.5">
                        SMTP Host *
                      </label>
                      <input
                        type="text"
                        name="smtpHost"
                        value={formData.smtpHost}
                        onChange={handleInputChange}
                        placeholder={t('account.smtpExampleCom')}
                        required
                        className="w-full px-3 py-2 bg-mail-bg border border-mail-border rounded-lg
                                  text-mail-text placeholder-mail-text-muted text-sm
                                  focus:border-mail-accent transition-all"
                      />
                    </div>
                    <div>
                      <label className="block text-sm text-mail-text-muted mb-1.5">
                        {t('account.smtpPort')}
                      </label>
                      <input
                        type="number"
                        name="smtpPort"
                        value={formData.smtpPort}
                        onChange={handleInputChange}
                        className="w-full px-3 py-2 bg-mail-bg border border-mail-border rounded-lg
                                  text-mail-text text-sm focus:border-mail-accent transition-all"
                      />
                    </div>
                  </div>
                </>
              )}

              {/* Error Message */}
              {error && (
                <motion.div
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="flex items-center gap-2 p-3 bg-mail-danger/10 border border-mail-danger/20
                            rounded-lg text-sm text-mail-danger"
                >
                  <AlertCircle size={16} className="flex-shrink-0 self-start mt-0.5" />
                  <div className="min-w-0">
                    <p>{typeof error === 'string' ? error : error.message}</p>
                    {typeof error !== 'string' && error.detail && (
                      <p className="mt-1 text-xs text-mail-text-muted break-words">{error.detail}</p>
                    )}
                  </div>
                </motion.div>
              )}

              {/* Success Message */}
              {success && (
                <motion.div
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="flex items-center gap-2 p-3 bg-mail-success/10 border border-mail-success/20
                            rounded-lg text-sm text-mail-success"
                >
                  <Check size={16} />
                  {t('account.accountAddedSuccessfully')}
                </motion.div>
              )}

              {/* Actions */}
              <div className="flex gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => {
                    setStep(1);
                    setShowManualConfig(false);
                    setDetectedProvider(null);
                    setAuthType('password');
                    setOauthConnected(false);
                    setOauthLoading(false);
                  }}
                  className="px-4 py-2.5 text-mail-text-muted hover:text-mail-text
                            transition-colors"
                >
                  {t('common.back')}
                </button>
                <Button
                  type="submit"
                  variant="primary"
                  size="lg"
                  className="flex-1"
                  disabled={testing || success || (authType === 'oauth2' && !oauthConnected)}
                  loading={testing}
                >
                  {testing ? t('account.testingConnection') : success ? (
                    <>
                      <Check size={18} />
                      {t('account.connected')}
                    </>
                  ) : (
                    'Add Account'
                  )}
                </Button>
              </div>
            </form>
          )}
        </div>

        <AnimatePresence>
          {showDiscardConfirm && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 bg-black/40 flex items-center justify-center z-10 rounded-2xl"
              onClick={() => setShowDiscardConfirm(false)}
            >
              <motion.div
                initial={{ scale: 0.95, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.95, opacity: 0 }}
                className="bg-mail-surface border border-mail-border rounded-xl p-6 mx-4 max-w-xs"
                onClick={(e) => e.stopPropagation()}
              >
                <h3 className="text-base font-semibold text-mail-text mb-2">{t('account.discardChanges')}</h3>
                <p className="text-sm text-mail-text-muted mb-4">
                  {t('account.allEnteredDetailsWillLost')}
                </p>
                <div className="flex gap-3">
                  <Button variant="subtle" size="sm" className="flex-1" onClick={() => setShowDiscardConfirm(false)}>
                    {t('account.keepEditing')}
                  </Button>
                  <Button variant="danger" size="sm" className="flex-1" onClick={onClose}>
                    {t('common.discard')}
                  </Button>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
    </Dialog>
  );
}
