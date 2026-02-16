import React from 'react';
import { motion } from 'framer-motion';
import { useSettingsStore } from '../stores/settingsStore';
import {
  Shield,
  Key,
  Lock,
  ArrowRight,
  Mail,
  HardDrive,
  EyeOff,
  XCircle
} from 'lucide-react';

const features = [
  {
    icon: Key,
    title: 'Secure Password Storage',
    description: 'Passwords stored in macOS Keychain'
  },
  {
    icon: Lock,
    title: 'Encrypted by macOS',
    description: 'Never saved in plain text files'
  },
  {
    icon: EyeOff,
    title: 'Privacy Protected',
    description: 'App cannot view your passwords'
  },
  {
    icon: HardDrive,
    title: 'Local Email Storage',
    description: 'Save emails for offline access'
  }
];

export function Onboarding() {
  const { setOnboardingComplete } = useSettingsStore();

  const handleComplete = () => {
    setOnboardingComplete(true);
  };

  return (
    <div className="h-screen bg-mail-bg flex items-center justify-center p-4 pt-8">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="max-w-lg w-full"
      >
        {/* Logo */}
        <div className="text-center mb-3">
          <h1 className="text-2xl font-display font-bold text-mail-text">
            <span className="text-mail-accent">Mail</span>Vault
          </h1>
          <p className="text-xs text-mail-text-muted">
            A secure, privacy-focused email client
          </p>
        </div>

        {/* Main Card */}
        <div className="bg-mail-surface border border-mail-border rounded-xl p-4 shadow-xl">
          {/* Security Header */}
          <div className="flex items-center gap-2 mb-3 pb-2 border-b border-mail-border">
            <div className="w-8 h-8 bg-mail-accent/10 rounded-lg flex items-center justify-center">
              <Shield size={16} className="text-mail-accent" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-mail-text">
                Your Security Matters
              </h2>
              <p className="text-xs text-mail-text-muted">
                How MailVault keeps your data safe
              </p>
            </div>
          </div>

          {/* Feature Cards - 2 columns, compact */}
          <div className="grid grid-cols-2 gap-2 mb-3">
            {features.map((feature, index) => {
              const Icon = feature.icon;
              return (
                <div
                  key={index}
                  className="p-2 rounded-lg border border-mail-border bg-mail-bg flex items-center gap-2"
                >
                  <div className="w-7 h-7 rounded bg-mail-accent/10 flex items-center justify-center flex-shrink-0">
                    <Icon size={14} className="text-mail-accent" />
                  </div>
                  <div className="min-w-0">
                    <h3 className="font-medium text-xs text-mail-text leading-tight">
                      {feature.title}
                    </h3>
                    <p className="text-[10px] text-mail-text-muted leading-tight">
                      {feature.description}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Keychain Permission Notice */}
          <div className="bg-mail-warning/10 border border-mail-warning/20 rounded-lg p-2 mb-3">
            <div className="flex items-center gap-2">
              <Key size={14} className="text-mail-warning flex-shrink-0" />
              <div>
                <h4 className="font-medium text-xs text-mail-warning">
                  Keychain Access Required
                </h4>
                <p className="text-[10px] text-mail-text-muted">
                  When adding an account, click "Always Allow" for secure password storage.
                </p>
              </div>
            </div>
          </div>

          {/* Action buttons */}
          <div className="flex items-center justify-between">
            <button
              onClick={handleComplete}
              className="flex items-center gap-1 px-2 py-1 text-[10px] text-mail-text-muted
                        hover:text-mail-text hover:bg-mail-bg rounded transition-colors"
            >
              <XCircle size={12} />
              Do not show again
            </button>
            <button
              onClick={handleComplete}
              className="flex items-center gap-1.5 px-4 py-1.5 bg-mail-accent
                        hover:bg-mail-accent-hover text-white font-medium rounded-lg
                        transition-all shadow-glow hover:shadow-glow-lg text-xs"
            >
              Get Started
              <Mail size={14} />
            </button>
          </div>
        </div>

        {/* Footer */}
        <p className="text-center text-[10px] text-mail-text-muted mt-2">
          Your privacy is our priority. Data never leaves your device.
        </p>
      </motion.div>
    </div>
  );
}
