import React from 'react';
import { Bug, Github, Mail, MessagesSquare } from 'lucide-react';
import { Dialog, Button } from './ui';
import { openInBrowser } from '../services/billingApi';

const GH_DISCUSSIONS = 'https://github.com/GraphicMeat/mail-vault-app/discussions';
const GH_NEW_BUG = `${GH_DISCUSSIONS}/new?category=bug-reports`;

/**
 * Where a bug report goes. GitHub first: a public thread is searchable by the
 * next person who hits the same thing, and email is a dead end for everyone
 * but the sender.
 */
export function BugReportDialog({ open, onClose, onEmail }) {
  const options = [
    {
      testid: 'bug-option-github',
      icon: Github,
      title: 'Report on GitHub',
      subtitle: 'Public thread — searchable, and you get notified on the fix',
      action: 'Open',
      variant: 'primary',
      url: GH_NEW_BUG,
      onClick: () => { openInBrowser(GH_NEW_BUG).catch(() => {}); onClose(); },
    },
    {
      testid: 'bug-option-email',
      icon: Mail,
      title: 'Email the developer',
      subtitle: 'Private, with your app and account details filled in',
      action: 'Compose',
      variant: 'subtle',
      onClick: onEmail,
    },
    {
      testid: 'bug-option-discussions',
      icon: MessagesSquare,
      title: 'Browse discussions',
      subtitle: 'Someone may have reported it already',
      action: 'Open',
      variant: 'subtle',
      url: GH_DISCUSSIONS,
      onClick: () => { openInBrowser(GH_DISCUSSIONS).catch(() => {}); onClose(); },
    },
  ];

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Report a bug"
      icon={<Bug size={20} className="text-mail-accent-text" />}
      description="Pick where it should land."
      size="lg"
      data-testid="bug-report-dialog"
    >
      <div className="space-y-2">
        {options.map(({ testid, icon: Icon, title, subtitle, action, variant, url, onClick }) => (
          <div
            key={testid}
            data-testid={testid}
            className="flex items-center gap-3 p-3 rounded-xl border border-mail-border bg-mail-surface"
          >
            <Icon size={18} className="text-mail-text-muted flex-shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-mail-text">{title}</div>
              <div className="text-xs text-mail-text-muted">{subtitle}</div>
            </div>
            <Button variant={variant} size="sm" onClick={onClick} data-url={url}>{action}</Button>
          </div>
        ))}
      </div>
    </Dialog>
  );
}
