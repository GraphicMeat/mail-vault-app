// Settings > Help & Support on the phone: desktop's Help view. Report a Bug (on GitHub, or Discord),
// desktop's links (website, blog, privacy policy, more apps) and the FAQ, each opened the way every
// link leaves the app (the system browser); then the phone's own rows: Replay tour (`onReplayTour`)
// and the source on GitHub with this build's version.
import React from 'react';
import { HelpCircle, RotateCcw } from 'lucide-react';
import { HelpView, OpenLinkButton } from '../../components/settings/views/HelpView';
import { Button } from '../../components/ui/Button';
import { DiscordLogo } from '../../components/ui/BrandGlyphs';
import { useT, getMobileLocale } from '../i18n.js';
import { faqUrl } from '../../services/faqUrl.js';
import { appLink } from '../../services/appLink.js';
import { DISCORD_INVITE } from '../../utils/communityLinks.js';
import { MobileViewEnv, openExternal } from './MobileViewEnv.jsx';

export const SOURCE_URL = 'https://github.com/GraphicMeat/mail-vault-app';
const SITE = 'https://mailvaultapp.com/';

export default function Help({ onReplayTour, version }) {
  const t = useT();
  const links = [
    ['settings-link-website', 'settings.help.mailvaultWebsite', 'settings.help.docsFaqLatestRelease', appLink(SITE, 'mobile_help')],
    ['settings-link-blog', 'settings.help.blog', 'settings.help.blogSubtitle', appLink(`${SITE}blog.html`, 'mobile_help')],
    ['settings-link-privacy', 'settings.help.privacyPolicy', 'settings.help.privacyPolicySubtitle', `${SITE}privacy.html`],
    ['settings-link-more-apps', 'settings.help.moreAppsGraphicmeat', 'settings.help.otherProductsMakerMailvault', 'https://graphicmeat.com'],
  ];
  const rows = [
    {
      id: 'report',
      title: t('settings.help.reportBug'),
      subtitle: t('settings.help.reportGithubEmailDeveloper'),
      action: (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="subtle" onClick={() => openExternal(DISCORD_INVITE)} data-url={DISCORD_INVITE}>
            <DiscordLogo size={16} />
            {t('bugReport.joinDiscord')}
          </Button>
          <Button variant="primary" onClick={() => openExternal(`${SOURCE_URL}/issues`)} data-url={`${SOURCE_URL}/issues`}>
            {t('settings.help.reportBug2')}
          </Button>
        </div>
      ),
    },
    ...links.map(([testid, titleKey, subtitleKey, url]) => ({
      id: testid, testid, title: t(titleKey), subtitle: t(subtitleKey), action: <OpenLinkButton url={url} onOpen={openExternal} />,
    })),
    {
      id: 'faq', testid: 'settings-link-faq', title: t('settings.help.faq'), subtitle: t('settings.help.faqSubtitle'),
      action: <OpenLinkButton url={faqUrl(getMobileLocale(), 'mobile_help')} onOpen={openExternal} icon={HelpCircle} />,
    },
    ...(onReplayTour ? [{
      id: 'tour', testid: 'mobile-replay-tour', title: t('mobile.settings.replayTour'),
      action: (
        <Button variant="subtle" onClick={onReplayTour} data-mv-replay-tour aria-label={t('mobile.settings.replayTour')}>
          <RotateCcw size={16} />
          {t('common.open')}
        </Button>
      ),
    }] : []),
    {
      id: 'source', testid: 'mobile-source', title: t('mobile.settings.source'),
      subtitle: version ? t('mobile.settings.version', { version }) : null,
      action: <OpenLinkButton url={SOURCE_URL} onOpen={openExternal} />,
    },
  ];
  return (
    <MobileViewEnv>
      <div data-mv-help>
        <HelpView rows={rows} />
      </div>
    </MobileViewEnv>
  );
}
