import { useState, useId } from 'react';
import { Button } from '../ui/Button';
import React from 'react';
import { useSettingsStore } from '../../stores/settingsStore';
import { openInBrowser } from '../../services/billingApi';
import { RotateCcw, Sparkles, HelpCircle } from 'lucide-react';
import { t as tr, useT  } from '../../i18n/index.js';
import { Dialog } from '../ui/Dialog';
import { Z } from '../ui/layers';
import { PremiumGallery } from '../onboarding/PremiumGallery';
import { faqUrl } from '../../services/faqUrl';
import { appLink } from '../../services/appLink.js';
import { DesktopViewEnv } from './DesktopViewEnv';
import { HelpView, OpenLinkButton } from './views/HelpView';
import { DiscordLogo } from '../ui/BrandGlyphs';
import { DISCORD_INVITE } from '../../utils/communityLinks';

// ponytail: the native Help menu's three links (src-tauri/src/main.rs), plus the
// privacy policy. Kept here too because the menu bar is invisible on Windows/Linux
// and unclickable in e2e.
const LINKS = () => ([
  {
    testid: 'settings-link-website',
    title: tr('settings.help.mailvaultWebsite'),
    subtitle: tr('settings.help.docsFaqLatestRelease'),
    url: appLink('https://mailvaultapp.com/', 'help_settings'),
  },
  {
    testid: 'settings-link-blog',
    title: tr('settings.help.blog'),
    subtitle: tr('settings.help.blogSubtitle'),
    url: appLink('https://mailvaultapp.com/blog.html', 'help_settings'),
  },
  {
    // Google's OAuth verification requires the privacy policy to be easy to
    // find inside the app, not only on the website.
    testid: 'settings-link-privacy',
    title: tr('settings.help.privacyPolicy'),
    subtitle: tr('settings.help.privacyPolicySubtitle'),
    url: 'https://mailvaultapp.com/privacy.html',
  },
  {
    testid: 'settings-link-more-apps',
    title: tr('settings.help.moreAppsGraphicmeat'),
    subtitle: tr('settings.help.otherProductsMakerMailvault'),
    url: 'https://graphicmeat.com',
  },
]);

export function HelpSettings({ onClose, onReportBug }) {
  const t = useT();
  const { setOnboardingComplete } = useSettingsStore();
  const language = useSettingsStore(s => s.language) || 'en';
  const [galleryOpen, setGalleryOpen] = useState(false);
  const galleryTitleId = useId();

  const open = url => openInBrowser(url).catch(() => {});
  const rows = [
    {
      id: 'report',
      title: t('settings.help.reportBug'),
      subtitle: t('settings.help.reportGithubEmailDeveloper'),
      action: (
        <div className="flex items-center gap-2">
          <span data-testid="settings-link-discord">
            <Button variant="subtle"
              onClick={() => openInBrowser(DISCORD_INVITE).catch(() => {})}
              data-url={DISCORD_INVITE}
            >
              <DiscordLogo size={16} />
              {t('bugReport.joinDiscord')}
            </Button>
          </span>
          <Button variant="primary"
            onClick={() => { onReportBug?.(); onClose(); }}
          >
            {t('settings.help.reportBug2')}
          </Button>
        </div>
      ),
    },
    ...LINKS().map(link => ({
      id: link.testid, testid: link.testid, title: link.title, subtitle: link.subtitle,
      action: <OpenLinkButton url={link.url} onOpen={open} />,
    })),
    {
      id: 'faq', testid: 'settings-link-faq', title: t('settings.help.faq'), subtitle: t('settings.help.faqSubtitle'),
      action: <OpenLinkButton url={faqUrl(language, 'help_settings')} onOpen={open} icon={HelpCircle} />,
    },
    {
      id: 'premium', title: t('settings.help.whatsInPremium'), subtitle: t('settings.help.whatsInPremiumSubtitle'),
      action: (
        <Button variant="subtle" onClick={() => setGalleryOpen(true)} data-testid="settings-open-premium-gallery">
          <Sparkles size={16} />
          {t('common.open')}
        </Button>
      ),
    },
    {
      id: 'reset', testid: 'settings-reset-onboarding', title: t('settings.help.resetOnboarding'), subtitle: t('settings.help.showWelcomeScreenAgainNext'),
      action: (
        <Button variant="subtle"
          onClick={() => {
            // No reload: `safeStorage` debounces the disk write 500ms, so a
            // reload here throws it away and the reset silently does nothing.
            // App.jsx already re-renders into <Onboarding/> on this flag.
            setOnboardingComplete(false);
            onClose();
          }}
        >
          <RotateCcw size={16} />
          {t('common.reset')}
        </Button>
      ),
    },
  ];

  return (
    <>
    <DesktopViewEnv>
      <HelpView rows={rows} />
    </DesktopViewEnv>

    <Dialog open={galleryOpen} onClose={() => setGalleryOpen(false)} z={Z.alert} portal size="lg"
            aria-labelledby={galleryTitleId}
            panelBg="bg-mail-surface">
      <h2 id={galleryTitleId} className="text-lg font-semibold text-mail-text mb-3">{t('onboarding.premiumTitle')}</h2>
      <PremiumGallery />
    </Dialog>
    </>
  );
}
