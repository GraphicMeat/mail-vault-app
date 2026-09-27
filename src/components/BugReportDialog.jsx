import React, { useEffect, useState } from 'react';
import { Bug, Github, HelpCircle, Lightbulb, Mail, MessagesSquare } from 'lucide-react';
import { Dialog, Button, XLogo } from './ui';
import { openInBrowser } from '../services/billingApi';
import { faqUrl } from '../services/faqUrl';
import { useSettingsStore } from '../stores/settingsStore';
import logoUrl from '../assets/graphicmeat-logo.webp';
import { t as tr, useT  } from '../i18n/index.js';

const GH_DISCUSSIONS = 'https://github.com/GraphicMeat/mail-vault-app/discussions';
const GH_NEW_BUG = `${GH_DISCUSSIONS}/new?category=bug-reports`;
const GH_NEW_IDEA = `${GH_DISCUSSIONS}/new?category=ideas`;
const X_PROFILE = 'https://x.com/GraphicMeat';
const MAKER_SITE = 'https://graphicmeat.com';

// One report every five minutes: filing a report is not reading help, so FAQ
// and Discussions stay open even while this is armed.
const COOLDOWN_MS = 300_000;

function formatCountdown(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Where a bug report goes, ordered as a deflection ladder: the FAQ answers it
 * outright, an existing discussion answers it second-hand, and only then does
 * a new thread get filed. A public thread is searchable by the next person who
 * hits the same thing; email is a dead end for everyone but the sender, so it
 * sits below the GitHub rows as the private fallback for anything that should
 * not be posted in the open.
 *
 * The dialog also takes feature requests — last, because it is not a bug.
 * Someone who has just hit something wrong is the same person who knows what
 * the app should have done instead, and this is the only moment MailVault has
 * their attention on the subject.
 */
export function BugReportDialog({ open, onClose, onEmail }) {
  const t = useT();
  const language = useSettingsStore(s => s.language) || 'en';
  const lastBugReportAt = useSettingsStore(s => s.lastBugReportAt);
  const setLastBugReportAt = useSettingsStore(s => s.setLastBugReportAt);
  const openAndClose = (url) => () => { openInBrowser(url).catch(() => {}); onClose(); };
  const FAQ = faqUrl(language);

  // Forces a re-render once a second, only while the dialog is open, so the
  // countdown reads live without a background timer running behind a closed
  // dialog. The remaining time itself is read straight off Date.now() below,
  // not off state, so a reopen after the dialog sat closed for a while never
  // renders one frame of a stale countdown before the tick corrects it.
  const [, tick] = useState(0);
  useEffect(() => {
    if (!open || !lastBugReportAt) return;
    const id = setInterval(() => tick(n => n + 1), 1000);
    return () => clearInterval(id);
  }, [open, lastBugReportAt]);

  const cooldownRemaining = lastBugReportAt ? Math.max(0, COOLDOWN_MS - (Date.now() - lastBugReportAt)) : 0;
  const inCooldown = cooldownRemaining > 0;
  const cooldownSubtitle = tr('bugReport.availableAgainIn', { time: formatCountdown(cooldownRemaining) });

  const reportGithub = () => { setLastBugReportAt(Date.now()); openAndClose(GH_NEW_BUG)(); };

  const options = [
    {
      testid: 'bug-option-faq',
      icon: HelpCircle,
      title: tr('settings.help.faq'),
      subtitle: tr('settings.help.faqSubtitle'),
      action: tr('common.open'),
      variant: 'subtle',
      url: FAQ,
      onClick: openAndClose(FAQ),
    },
    {
      testid: 'bug-option-discussions',
      icon: MessagesSquare,
      title: tr('bugReport.browseDiscussions'),
      subtitle: tr('bugReport.someoneMayReportedAskedAlready'),
      action: tr('common.open'),
      variant: 'subtle',
      url: GH_DISCUSSIONS,
      onClick: openAndClose(GH_DISCUSSIONS),
    },
    {
      testid: 'bug-option-github',
      icon: Github,
      title: tr('bugReport.reportGithub'),
      subtitle: inCooldown ? cooldownSubtitle : tr('bugReport.publicThreadSearchableGetNotified'),
      action: tr('common.open'),
      variant: 'primary',
      url: GH_NEW_BUG,
      onClick: reportGithub,
      disabled: inCooldown,
    },
    {
      testid: 'bug-option-email',
      icon: Mail,
      title: tr('bugReport.emailDeveloper'),
      subtitle: inCooldown ? cooldownSubtitle : tr('bugReport.privateAppAccountDetailsFilled'),
      action: tr('sidebar.compose'),
      variant: 'subtle',
      onClick: onEmail,
      disabled: inCooldown,
    },
    {
      testid: 'bug-option-idea',
      icon: Lightbulb,
      title: tr('bugReport.suggestFeature'),
      // Not stamped: filing an idea does not arm the cooldown. It is still
      // disabled while armed — the brief names only FAQ and Discussions as
      // staying open, because reading help is not reporting; this row files
      // a GitHub thread same as the other two.
      subtitle: inCooldown ? cooldownSubtitle : tr('bugReport.thingWishMailvaultDidAsk'),
      action: tr('common.open'),
      variant: 'subtle',
      url: GH_NEW_IDEA,
      onClick: openAndClose(GH_NEW_IDEA),
      disabled: inCooldown,
    },
  ];

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('bugReport.reportBugSuggestFeature')}
      icon={<Bug size={20} className="text-mail-accent-text" />}
      description={t('bugReport.description')}
      size="lg"
      data-testid="bug-report-dialog"
    >
      <div className="space-y-2">
        {options.map(({ testid, icon: Icon, title, subtitle, action, variant, url, onClick, disabled }) => (
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
            <Button variant={variant} size="sm" onClick={onClick} disabled={disabled} data-url={url} aria-label={`${action}: ${title}`}>{action}</Button>
          </div>
        ))}
      </div>

      <p className="text-xs text-mail-text-muted leading-relaxed" data-testid="bug-privacy-note">
        {t('bugReport.githubThreadIsPublic')}
      </p>

      <div className="pt-3 border-t border-mail-border flex flex-col items-center gap-3">
        <button
          type="button"
          data-testid="bug-follow-x"
          data-url={X_PROFILE}
          onClick={openAndClose(X_PROFILE)}
          className="inline-flex items-center gap-2 text-xs text-mail-text-muted hover:text-mail-text transition-colors"
        >
          <XLogo size={14} /> {t('bugReport.followX')}
        </button>

        <div className="flex flex-col items-center gap-1 text-xs text-mail-text-muted">
          <span>{t('bugReport.cookedOver')} <span className="text-mail-accent-text font-medium">{t('bugReport.openGpu')}</span> {t('bugReport.by')}</span>
          <button
            type="button"
            data-testid="bug-maker-logo"
            data-url={MAKER_SITE}
            aria-label={t('bugReport.graphicMeat')}
            onClick={openAndClose(MAKER_SITE)}
            className="hover:opacity-80 transition-opacity"
          >
            <img src={logoUrl} alt={t('bugReport.graphicMeat')} width="128" height="128" className="w-16 h-16" />
          </button>
        </div>
      </div>
    </Dialog>
  );
}
