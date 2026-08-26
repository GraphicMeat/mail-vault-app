import { Button } from '../ui/Button';
import React from 'react';
import { useSettingsStore } from '../../stores/settingsStore';
import { openInBrowser } from '../../services/billingApi';
import {
  Mail,
  RotateCcw,
  ExternalLink,
} from 'lucide-react';

// ponytail: same two links as the native Help menu (src-tauri/src/main.rs).
// Kept here too because the menu bar is invisible on Windows/Linux and unclickable in e2e.
const LINKS = [
  {
    testid: 'settings-link-website',
    title: 'MailVault Website',
    subtitle: 'Docs, FAQ and the latest release',
    url: 'https://mailvaultapp.com',
  },
  {
    testid: 'settings-link-more-apps',
    title: 'More Apps by GraphicMeat',
    subtitle: 'Other products from the maker of MailVault',
    url: 'https://graphicmeat.com',
  },
];

export function HelpSettings({ onClose, onReportBug }) {
  const { setOnboardingComplete } = useSettingsStore();

  return (
    <div className="p-6 space-y-6">
      <div className="bg-mail-surface border border-mail-border rounded-xl p-5">
        <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
          <Mail size={18} className="text-mail-accent-text" />
          Help & Support
        </h4>

        <div className="space-y-4">
          <div className="flex items-center justify-between py-2">
            <div>
              <div className="font-medium text-mail-text">Report a Bug</div>
              <div className="text-sm text-mail-text-muted">
                Send a bug report email to the developer
              </div>
            </div>
            <Button variant="primary"
              onClick={() => { onReportBug?.(); onClose(); }}
            >
              Report Bug
            </Button>
          </div>

          {LINKS.map((link) => (
            <React.Fragment key={link.testid}>
              <div className="border-t border-mail-border" />
              <div className="flex items-center justify-between py-2" data-testid={link.testid}>
                <div>
                  <div className="font-medium text-mail-text">{link.title}</div>
                  <div className="text-sm text-mail-text-muted">{link.subtitle}</div>
                </div>
                <Button variant="subtle"
                  onClick={() => openInBrowser(link.url).catch(() => {})}
                  data-url={link.url}
                >
                  <ExternalLink size={16} />
                  Open
                </Button>
              </div>
            </React.Fragment>
          ))}

          <div className="border-t border-mail-border" />

          <div className="flex items-center justify-between py-2">
            <div>
              <div className="font-medium text-mail-text">Reset Onboarding</div>
              <div className="text-sm text-mail-text-muted">
                Show the welcome screen again on next launch
              </div>
            </div>
            <Button variant="subtle"
              onClick={() => {
                setOnboardingComplete(false);
                window.location.reload();
              }}
            >
              <RotateCcw size={16} />
              Reset
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
