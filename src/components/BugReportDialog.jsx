import React from 'react';
import { Bug, Github, Mail, MessagesSquare } from 'lucide-react';
import { Dialog, Button, XLogo } from './ui';
import { openInBrowser } from '../services/billingApi';
import logoUrl from '../assets/graphicmeat-logo.webp';

const GH_DISCUSSIONS = 'https://github.com/GraphicMeat/mail-vault-app/discussions';
const GH_NEW_BUG = `${GH_DISCUSSIONS}/new?category=bug-reports`;
const X_PROFILE = 'https://x.com/GraphicMeat';
const MAKER_SITE = 'https://graphicmeat.com';

/**
 * Where a bug report goes. GitHub first: a public thread is searchable by the
 * next person who hits the same thing, and email is a dead end for everyone
 * but the sender — so email sits last, as the private fallback for anything
 * that should not be posted in the open.
 */
export function BugReportDialog({ open, onClose, onEmail }) {
  const openAndClose = (url) => () => { openInBrowser(url).catch(() => {}); onClose(); };

  const options = [
    {
      testid: 'bug-option-github',
      icon: Github,
      title: 'Report on GitHub',
      subtitle: 'Public thread — searchable, and you get notified on the fix',
      action: 'Open',
      variant: 'primary',
      url: GH_NEW_BUG,
      onClick: openAndClose(GH_NEW_BUG),
    },
    {
      testid: 'bug-option-discussions',
      icon: MessagesSquare,
      title: 'Browse discussions',
      subtitle: 'Someone may have reported it already',
      action: 'Open',
      variant: 'subtle',
      url: GH_DISCUSSIONS,
      onClick: openAndClose(GH_DISCUSSIONS),
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

      <p className="text-xs text-mail-text-muted leading-relaxed" data-testid="bug-privacy-note">
        A GitHub thread is public. Keep sensitive data out of it, and never upload
        logs there — logs carry email addresses. If a log would help, send it over
        email instead.
      </p>

      <div className="pt-3 border-t border-mail-border flex flex-col items-center gap-3">
        <button
          type="button"
          data-testid="bug-follow-x"
          data-url={X_PROFILE}
          onClick={openAndClose(X_PROFILE)}
          className="inline-flex items-center gap-2 text-xs text-mail-text-muted hover:text-mail-text transition-colors"
        >
          <XLogo size={14} /> Follow on X
        </button>

        <div className="flex flex-col items-center gap-1 text-xs text-mail-text-muted">
          <span>Cooked over an <span className="text-mail-accent-text font-medium">open GPU</span> by</span>
          <button
            type="button"
            data-testid="bug-maker-logo"
            data-url={MAKER_SITE}
            aria-label="Graphic Meat"
            onClick={openAndClose(MAKER_SITE)}
            className="hover:opacity-80 transition-opacity"
          >
            <img src={logoUrl} alt="Graphic Meat" width="128" height="128" className="w-32 h-32" />
          </button>
        </div>
      </div>
    </Dialog>
  );
}
