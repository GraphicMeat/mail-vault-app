import React from 'react';
import { SpellCheck } from 'lucide-react';
import { Dialog, Button } from './ui';
import { openInBrowser } from '../services/billingApi';
import { t as tr, useT  } from '../i18n/index.js';

export const SPELLCHECK_FAQ_URL = 'https://mailvaultapp.com/faq.html#linux-spellcheck-dictionary';

// One package name per family, all for US English, because the list has to be
// copyable rather than complete — the line under it says how to swap languages.
const COMMANDS = () => ([
  { family: tr('spellcheck.debianUbuntuMint'), command: tr('spellcheck.sudoAptInstallHunspellEn') },
  { family: tr('spellcheck.fedora'), command: tr('spellcheck.sudoDnfInstallHunspellEn') },
  { family: tr('spellcheck.archManjaro'), command: tr('spellcheck.sudoPacmanSHunspellEn') },
  { family: 'openSUSE', command: tr('spellcheck.sudoZypperInstallMyspellEn') },
]);

/**
 * What the spellcheck button says on Linux when there is nothing to check
 * against.
 *
 * macOS and Windows ship a checker with the system. Linux leaves it to the
 * desktop: WebKit asks enchant, enchant asks hunspell, and hunspell needs a
 * dictionary package that a minimal install does not have. Rather than a
 * toggle that lights up and changes nothing, the button opens this.
 *
 * @param {boolean} confined  running as a snap, where installing a dictionary
 *                            on the host cannot reach the app
 */
export function SpellcheckHelpDialog({ open, onClose, confined = false }) {
  const t = useT();
  return (
    <Dialog
      open={open}
      onClose={onClose}
      portal
      size="md"
      title={t('spellcheck.spellcheckNeedsDictionary')}
      data-testid="spellcheck-help-dialog"
      icon={<SpellCheck size={18} className="text-mail-accent-text" />}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>{t('common.close')}</Button>
          <Button
            variant="primary"
            onClick={() => { openInBrowser(SPELLCHECK_FAQ_URL).catch(() => {}); }}
            data-testid="spellcheck-help-guide"
          >
            {t('spellcheck.readGuide')}
          </Button>
        </div>
      }
    >
      <div className="space-y-4 text-sm text-mail-text">
        <p className="text-mail-text-muted">
          On Linux the spelling dictionary comes from your system, not from MailVault,
          and this machine has none installed. Until one is there, the spellcheck
          button has nothing to underline.
        </p>

        {confined ? (
          <p className="text-mail-text-muted" data-testid="spellcheck-help-snap">
            This is the snap build. A snap cannot see dictionaries installed on the
            host, so it carries its own — and if you are reading this, that copy is
            missing. The .deb package from mailvaultapp.com uses your system's
            dictionaries instead; the guide below has the details.
          </p>
        ) : (
          <>
            <div className="space-y-2">
              {COMMANDS().map(({ family, command }) => (
                <div key={family}>
                  <div className="text-xs text-mail-text-muted">{family}</div>
                  <code className="block mt-0.5 px-3 py-2 rounded bg-mail-surface border border-mail-border font-mono text-xs break-all">
                    {command}
                  </code>
                </div>
              ))}
            </div>
            <p className="text-mail-text-muted">
              {t('spellcheck.anotherLanguageSwapCountryCode')} <code className="font-mono text-xs">{t('spellcheck.hunspellDeDe')}</code>,{' '}
              <code className="font-mono text-xs">{t('spellcheck.hunspellFr')}</code>, and so on. MailVault
              picks the dictionary that matches your system language.
            </p>
          </>
        )}

        <p className="text-mail-text-muted">
          Restart MailVault once the dictionary is installed — the checker is set up
          when the app starts.
        </p>
      </div>
    </Dialog>
  );
}
