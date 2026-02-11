import React, { useState } from 'react';
import { useMailStore } from '../stores/mailStore';
import { motion } from 'framer-motion';
import { X, Mail, Lock, Server, Eye, EyeOff, Check, AlertCircle, Loader, Wand2 } from 'lucide-react';

// Common email provider configurations
const PROVIDER_CONFIGS = {
  gmail: {
    name: 'Gmail',
    domains: ['gmail.com', 'googlemail.com'],
    imapHost: 'imap.gmail.com',
    imapPort: 993,
    smtpHost: 'smtp.gmail.com',
    smtpPort: 587,
    note: 'Use an App Password if 2FA is enabled'
  },
  outlook: {
    name: 'Outlook/Hotmail',
    domains: ['outlook.com', 'hotmail.com', 'live.com', 'msn.com'],
    imapHost: 'outlook.office365.com',
    imapPort: 993,
    smtpHost: 'smtp.office365.com',
    smtpPort: 587,
    note: 'Use your Microsoft account password'
  },
  yahoo: {
    name: 'Yahoo Mail',
    domains: ['yahoo.com', 'yahoo.co.uk', 'ymail.com'],
    imapHost: 'imap.mail.yahoo.com',
    imapPort: 993,
    smtpHost: 'smtp.mail.yahoo.com',
    smtpPort: 587,
    note: 'Generate an App Password in Yahoo settings'
  },
  icloud: {
    name: 'iCloud Mail',
    domains: ['icloud.com', 'me.com', 'mac.com'],
    imapHost: 'imap.mail.me.com',
    imapPort: 993,
    smtpHost: 'smtp.mail.me.com',
    smtpPort: 587,
    note: 'Generate an App-Specific Password'
  },
  aol: {
    name: 'AOL Mail',
    domains: ['aol.com'],
    imapHost: 'imap.aol.com',
    imapPort: 993,
    smtpHost: 'smtp.aol.com',
    smtpPort: 587,
    note: 'Use an App Password'
  },
  zoho: {
    name: 'Zoho Mail',
    domains: ['zoho.com', 'zohomail.com'],
    imapHost: 'imap.zoho.com',
    imapPort: 993,
    smtpHost: 'smtp.zoho.com',
    smtpPort: 587,
    note: 'Enable IMAP in Zoho settings'
  },
  protonmail: {
    name: 'ProtonMail',
    domains: ['protonmail.com', 'proton.me', 'pm.me'],
    imapHost: '127.0.0.1',
    imapPort: 1143,
    smtpHost: '127.0.0.1',
    smtpPort: 1025,
    note: 'Requires ProtonMail Bridge app'
  },
  fastmail: {
    name: 'Fastmail',
    domains: ['fastmail.com', 'fastmail.fm'],
    imapHost: 'imap.fastmail.com',
    imapPort: 993,
    smtpHost: 'smtp.fastmail.com',
    smtpPort: 587,
    note: 'Use an App Password'
  }
};

// Try to detect provider from email domain
function detectProvider(email) {
  const domain = email.split('@')[1]?.toLowerCase();
  if (!domain) return null;
  
  for (const [key, config] of Object.entries(PROVIDER_CONFIGS)) {
    if (config.domains?.includes(domain)) {
      return { key, config };
    }
  }
  
  return null;
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

export function AccountModal({ onClose }) {
  const { addAccount } = useMailStore();
  
  const [step, setStep] = useState(1);
  const [provider, setProvider] = useState(null);
  const [showPassword, setShowPassword] = useState(false);
  const [testing, setTesting] = useState(false);
  const [autoDetecting, setAutoDetecting] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(false);
  const [detectedProvider, setDetectedProvider] = useState(null);
  const [showManualConfig, setShowManualConfig] = useState(false);
  
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    password: '',
    imapHost: '',
    imapPort: 993,
    imapSecure: true,
    smtpHost: '',
    smtpPort: 587,
    smtpSecure: false
  });
  
  const handleProviderSelect = (key) => {
    const config = key === 'custom' 
      ? { imapHost: '', imapPort: 993, smtpHost: '', smtpPort: 587 }
      : PROVIDER_CONFIGS[key];
    
    setProvider(key);
    setFormData(prev => ({
      ...prev,
      imapHost: config.imapHost,
      imapPort: config.imapPort,
      smtpHost: config.smtpHost,
      smtpPort: config.smtpPort
    }));
    
    if (key === 'custom') {
      setShowManualConfig(false);
    }
    
    setStep(2);
  };
  
  const handleInputChange = (e) => {
    const { name, value, type, checked } = e.target;
    setFormData(prev => ({
      ...prev,
      [name]: type === 'checkbox' ? checked : value
    }));
    setError(null);
    
    // Auto-detect provider when email changes
    if (name === 'email' && value.includes('@')) {
      const detected = detectProvider(value);
      setDetectedProvider(detected);
    }
  };
  
  const handleAutoDetect = async () => {
    if (!formData.email || !formData.password) {
      setError('Please enter email and password first');
      return;
    }
    
    setAutoDetecting(true);
    setError(null);
    
    // First check if we know this provider
    const detected = detectProvider(formData.email);
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
          const response = await fetch('/api/test-connection', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ account: testAccount })
          });
          
          const result = await response.json();
          
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
                name: `Auto-detected (${pattern.imapHost})`,
                ...pattern,
                imapPort: guess.imapPort,
                smtpPort: guess.smtpPort
              } 
            });
            foundWorking = true;
            break;
          }
        } catch (e) {
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
        setError('Could not auto-detect server settings. Please enter them manually.');
      }
      
      setShowManualConfig(true);
    }
    
    setAutoDetecting(false);
  };
  
  const handleSubmit = async (e) => {
    e.preventDefault();
    console.log('[AccountModal] handleSubmit called');
    console.log('[AccountModal] formData:', { ...formData, password: '***' });
    setError(null);
    setTesting(true);

    try {
      console.log('[AccountModal] Calling addAccount...');
      await addAccount(formData);
      console.log('[AccountModal] addAccount completed successfully');
      setSuccess(true);
      setTimeout(() => {
        onClose();
      }, 1500);
    } catch (err) {
      console.error('[AccountModal] addAccount failed:', err);
      console.error('[AccountModal] Error type:', typeof err);
      console.error('[AccountModal] Error message:', err?.message);
      console.error('[AccountModal] Error stack:', err?.stack);
      setError(err.message || 'Failed to connect to email server');
    } finally {
      setTesting(false);
    }
  };
  
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.95, opacity: 0 }}
        className="bg-mail-surface border border-mail-border rounded-2xl shadow-2xl 
                   w-full max-w-md overflow-hidden max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-mail-border">
          <h2 className="text-lg font-semibold text-mail-text">
            {step === 1 ? 'Choose Email Provider' : 'Add Account'}
          </h2>
          <button
            onClick={onClose}
            className="p-1 hover:bg-mail-border rounded-lg transition-colors"
          >
            <X size={20} className="text-mail-text-muted" />
          </button>
        </div>
        
        {/* Content */}
        <div className="p-6 overflow-y-auto">
          {step === 1 ? (
            <div className="space-y-2">
              {Object.entries(PROVIDER_CONFIGS).slice(0, 6).map(([key, config]) => (
                <button
                  key={key}
                  onClick={() => handleProviderSelect(key)}
                  className="w-full flex items-center gap-4 p-4 rounded-xl border border-mail-border
                            hover:border-mail-accent/50 hover:bg-mail-surface-hover 
                            transition-all text-left group"
                >
                  <div className="w-10 h-10 bg-mail-accent/10 rounded-lg flex items-center 
                                justify-center group-hover:bg-mail-accent/20 transition-colors">
                    <Mail size={20} className="text-mail-accent" />
                  </div>
                  <div>
                    <div className="font-medium text-mail-text">{config.name}</div>
                    <div className="text-sm text-mail-text-muted">{config.imapHost}</div>
                  </div>
                </button>
              ))}
              
              <button
                onClick={() => handleProviderSelect('custom')}
                className="w-full flex items-center gap-4 p-4 rounded-xl border border-mail-border
                          hover:border-mail-accent/50 hover:bg-mail-surface-hover 
                          transition-all text-left group"
              >
                <div className="w-10 h-10 bg-mail-accent/10 rounded-lg flex items-center 
                              justify-center group-hover:bg-mail-accent/20 transition-colors">
                  <Server size={20} className="text-mail-accent" />
                </div>
                <div>
                  <div className="font-medium text-mail-text">Other / Custom</div>
                  <div className="text-sm text-mail-text-muted">Auto-detect or manual config</div>
                </div>
              </button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              {/* Provider Note */}
              {provider && PROVIDER_CONFIGS[provider]?.note && (
                <div className="flex items-start gap-3 p-3 bg-mail-accent/10 rounded-lg text-sm">
                  <AlertCircle size={16} className="text-mail-accent mt-0.5 flex-shrink-0" />
                  <span className="text-mail-text">{PROVIDER_CONFIGS[provider].note}</span>
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
              
              {/* Display Name */}
              <div>
                <label className="block text-sm text-mail-text-muted mb-1.5">
                  Display Name (optional)
                </label>
                <input
                  type="text"
                  name="name"
                  value={formData.name}
                  onChange={handleInputChange}
                  placeholder="John Doe"
                  className="w-full px-4 py-2.5 bg-mail-bg border border-mail-border rounded-lg
                            text-mail-text placeholder-mail-text-muted
                            focus:border-mail-accent focus:ring-1 focus:ring-mail-accent
                            transition-all"
                />
              </div>
              
              {/* Email */}
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
                    placeholder="you@example.com"
                    required
                    className="w-full pl-10 pr-4 py-2.5 bg-mail-bg border border-mail-border rounded-lg
                              text-mail-text placeholder-mail-text-muted
                              focus:border-mail-accent focus:ring-1 focus:ring-mail-accent
                              transition-all"
                  />
                </div>
              </div>
              
              {/* Password */}
              <div>
                <label className="block text-sm text-mail-text-muted mb-1.5">
                  Password / App Password *
                </label>
                <div className="relative">
                  <Lock size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-mail-text-muted" />
                  <input
                    type={showPassword ? 'text' : 'password'}
                    name="password"
                    value={formData.password}
                    onChange={handleInputChange}
                    placeholder="••••••••••••"
                    required
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
                      Detecting settings...
                    </>
                  ) : (
                    <>
                      <Wand2 size={18} />
                      Auto-detect Server Settings
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
                      Server Settings
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
                        placeholder="imap.example.com"
                        required
                        className="w-full px-3 py-2 bg-mail-bg border border-mail-border rounded-lg
                                  text-mail-text placeholder-mail-text-muted text-sm
                                  focus:border-mail-accent transition-all"
                      />
                    </div>
                    <div>
                      <label className="block text-sm text-mail-text-muted mb-1.5">
                        IMAP Port
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
                        placeholder="smtp.example.com"
                        required
                        className="w-full px-3 py-2 bg-mail-bg border border-mail-border rounded-lg
                                  text-mail-text placeholder-mail-text-muted text-sm
                                  focus:border-mail-accent transition-all"
                      />
                    </div>
                    <div>
                      <label className="block text-sm text-mail-text-muted mb-1.5">
                        SMTP Port
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
                  <AlertCircle size={16} />
                  {error}
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
                  Account added successfully!
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
                  }}
                  className="px-4 py-2.5 text-mail-text-muted hover:text-mail-text
                            transition-colors"
                >
                  Back
                </button>
                <button
                  type="submit"
                  disabled={testing || success}
                  className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 
                            bg-mail-accent hover:bg-mail-accent-hover disabled:opacity-50
                            text-white font-medium rounded-lg transition-all
                            shadow-glow hover:shadow-glow-lg disabled:shadow-none"
                >
                  {testing ? (
                    <>
                      <Loader size={18} className="animate-spin" />
                      Testing Connection...
                    </>
                  ) : success ? (
                    <>
                      <Check size={18} />
                      Connected!
                    </>
                  ) : (
                    'Add Account'
                  )}
                </button>
              </div>
            </form>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}
