import React from 'react';
import { Shield } from 'lucide-react';
import { useSettingsStore } from '../../stores/settingsStore';
import { ToggleSwitch } from './ToggleSwitch';

export function SecuritySettings() {
  const linkSafetyEnabled = useSettingsStore(s => s.linkSafetyEnabled);
  const linkSafetyClickConfirm = useSettingsStore(s => s.linkSafetyClickConfirm);
  const setLinkSafetyEnabled = useSettingsStore(s => s.setLinkSafetyEnabled);
  const setLinkSafetyClickConfirm = useSettingsStore(s => s.setLinkSafetyClickConfirm);

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-2 mb-2">
        <Shield size={18} className="text-mail-accent" />
        <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-mail-accent/15 text-mail-accent">Premium</span>
      </div>

      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-medium text-mail-text">Link Safety Scanning</div>
            <div className="text-xs text-mail-text-muted mt-0.5">
              Detect suspicious links in emails that don't match their displayed text
            </div>
          </div>
          <ToggleSwitch checked={linkSafetyEnabled} onChange={setLinkSafetyEnabled} />
        </div>

        <div className={`flex items-center justify-between ${!linkSafetyEnabled ? 'opacity-50 pointer-events-none' : ''}`}>
          <div>
            <div className="text-sm font-medium text-mail-text">Click Confirmation</div>
            <div className="text-xs text-mail-text-muted mt-0.5">
              Show a warning modal before opening suspicious links
            </div>
          </div>
          <ToggleSwitch checked={linkSafetyClickConfirm} onChange={setLinkSafetyClickConfirm} />
        </div>
      </div>

      <div className="pt-4 border-t border-mail-border">
        <h4 className="text-sm font-medium text-mail-text mb-2">How it works</h4>
        <div className="text-xs text-mail-text-muted space-y-1">
          <p><span className="text-red-500 font-medium">Red alerts</span> — Link text shows one URL but actually goes to a different domain (phishing indicator)</p>
          <p><span className="text-amber-500 font-medium">Yellow alerts</span> — Link passes through a tracking redirect to a different domain</p>
        </div>
      </div>
    </div>
  );
}
