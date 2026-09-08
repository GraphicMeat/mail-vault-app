import React, { useMemo, useRef, useEffect, useState } from 'react';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { useAccountStore } from '../../stores/accountStore';
import { useMailStore } from '../../stores/mailStore';
import { resolveEmailLocation, emailScopeKey } from '../../stores/slices/unifiedHelpers';
import { useSelectionStore } from '../../stores/selectionStore';
import { useSettingsStore, isTrackerBlockingActive } from '../../stores/settingsStore';
import { useThemeStore } from '../../stores/themeStore';
import { getEmailColors } from '../../utils/mailChrome';
import { getDarkReaderInlineScripts } from '../../utils/darkReaderInject';
import { formatDateTime } from '../../utils/dateFormat';
import { X, Loader, Sun, Moon } from 'lucide-react';
import { AttachmentItem } from '../EmailViewer';
import { getRealAttachments, replaceCidUrls } from '../../services/attachmentUtils';
import { checkLinkAlert } from '../../utils/linkSafety';
import { scanTrackers } from '../../utils/trackerDetect';
import { recordTrackerVerdict } from '../../services/trackerVerdicts';
import { LinkSafetyModal } from '../LinkSafetyModal';
import { openMailtoCompose, plainTextBodyHtml } from '../../utils/mailto';
import { buildEmailIframeHtml, getEmailBodyContent } from '../../utils/emailIframeTemplate';
import { t as tr, useT  } from '../../i18n/index.js';

// Full-screen modal for viewing complete email with HTML rendering
export function FullViewEmailModal({ email: initialEmail, onClose }) {
  const t = useT();
  const selectEmail = useSelectionStore(s => s.selectEmail);
  const selectedEmail = useSelectionStore(s => s.selectedEmail);
  const loadingEmail = useSelectionStore(s => s.loadingEmail);
  const activeAccountId = useAccountStore(s => s.activeAccountId);
  const activeMailbox = useAccountStore(s => s.activeMailbox);
  const iframeRef = useRef(null);
  const [fetchedEmail, setFetchedEmail] = useState(null);
  const [linkSafetyAlert, setLinkSafetyAlert] = useState(null);
  const linkSafetyEnabled = useSettingsStore(s => s.linkSafetyEnabled);
  const trackerBlocking = useSettingsStore(isTrackerBlockingActive);
  const appTheme = useThemeStore(s => s.theme);
  const palette = useThemeStore(s => s.palette);
  const emailViewerTheme = useSettingsStore(s => s.emailViewerTheme);
  const [themeOverride, setThemeOverride] = useState(null);
  const theme = themeOverride ?? (emailViewerTheme === 'system' ? appTheme : emailViewerTheme);
  const isDark = theme === 'dark';
  const emailColors = getEmailColors(theme, palette);
  useEffect(() => setThemeOverride(null), [initialEmail.uid, initialEmail._accountId, initialEmail._mailbox]);
  const linkSafetyClickConfirm = useSettingsStore(s => s.linkSafetyClickConfirm);

  // Fetch full email content if not already available
  useEffect(() => {
    const fetchFullEmail = async () => {
      // Check if we already have full content (non-empty html or text)
      const hasContent = (initialEmail.html && initialEmail.html.trim().length > 0) ||
                         (initialEmail.text && initialEmail.text.trim().length > 0);

      if (hasContent) {
        setFetchedEmail(initialEmail);
        return;
      }

      // Need to fetch full content - use selectEmail
      try {
        await selectEmail(initialEmail.uid, initialEmail.source || 'server');
      } catch (e) {
        console.error('Failed to fetch full email:', e);
        // Even if fetch fails, set the initial email so we show something
        setFetchedEmail(initialEmail);
      }
    };

    fetchFullEmail();
  }, [initialEmail, selectEmail]);

  // Use selectedEmail from store if we just fetched it
  useEffect(() => {
    if (selectedEmail && selectedEmail.uid === initialEmail.uid) {
      setFetchedEmail(selectedEmail);
    }
  }, [selectedEmail, initialEmail.uid]);

  // Use fetched email or fall back to initial
  const email = fetchedEmail || initialEmail;

  // Fourth renderer, same duty: record what the body carries so the row it was
  // opened from shows the glyph. `scanTrackers` is cached per key + body
  // fingerprint, so this is not a second parse of the same message.
  useEffect(() => {
    if (!email?.html) return;
    const key = emailScopeKey(email, useMailStore.getState());
    if (!key) return;
    recordTrackerVerdict(key, scanTrackers(replaceCidUrls(email.html, email.attachments), key).trackers);
  }, [email]);

  // Build full HTML content for iframe
  const iframeContent = useMemo(() => {
    // Escapes (including `&`, which the hand-rolled pair here used to let
    // through) and turns any address into a mailto: the frame's click
    // handler already knows what to do with.
    const htmlBody = email.html || plainTextBodyHtml(email.text || email.textBody || '(No content)');

    // Full-view is a fourth renderer of the same body; blocking holds here too.
    const cidResolved = replaceCidUrls(htmlBody, email.attachments);
    const scannedForFrame = trackerBlocking
      ? scanTrackers(cidResolved, emailScopeKey(email, useMailStore.getState())).cleanedBodyHtml
      : cidResolved;
    return buildEmailIframeHtml({
      bodyHtml: getEmailBodyContent(scannedForFrame),
      themeTag: theme,
      extraHead: isDark ? getDarkReaderInlineScripts({ palette }) : '',
    });
  }, [email, trackerBlocking, theme, palette]);

  // Intercept links and prevent native context menu in full-view iframe
  useEffect(() => {
    if (!iframeRef.current) return;
    const iframe = iframeRef.current;
    const setup = () => {
      try {
        const doc = iframe.contentDocument || iframe.contentWindow?.document;
        if (!doc) return;
        doc.addEventListener('contextmenu', (e) => e.preventDefault());
        doc.addEventListener('click', (e) => {
          const link = e.target.closest('a');
          if (!link || !link.href) return;
          // An address in the body composes here instead of waking the OS mail
          // client, which is not the vault this message lives in.
          if (link.href.startsWith('mailto:')) {
            e.preventDefault();
            e.stopPropagation();
            openMailtoCompose(link.href, email?._accountId);
            return;
          }
          if (link.href.startsWith('cid:') || link.href.startsWith('tel:') || link.href.startsWith('#')) return;
          e.preventDefault();
          if (linkSafetyEnabled && linkSafetyClickConfirm) {
            const alert = checkLinkAlert(link);
            if (alert) { setLinkSafetyAlert(alert); return; }
          }
          import('@tauri-apps/plugin-shell').then(({ open }) => {
              open(link.href);
            }).catch(() => {
              window.open(link.href, '_blank');
            });
        });
      } catch (e) { /* iframe access error */ }
    };
    iframe.addEventListener('load', setup);
    setup(); // in case already loaded
    return () => iframe.removeEventListener('load', setup);
  }, [email]);

  return (
    <Dialog
      open={Boolean(email)}
      onClose={onClose}
      size="full"
      panelBg="bg-mail-surface"
      aria-label={t('email.fullView.fullMessage')}
      className="p-4"
      panelClassName="min-h-0 rounded-2xl overflow-hidden flex flex-col"
    >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-mail-border bg-mail-bg shrink-0">
          <div className="flex-1 min-w-0 mr-4">
            <h2 className="font-semibold text-mail-text truncate text-lg">
              {email.subject || '(No subject)'}
            </h2>
          </div>
          <Button variant="ghost" size="sm" onClick={() => setThemeOverride(isDark ? 'light' : 'dark')} className="mr-2">
            {isDark ? <Sun size={16} /> : <Moon size={16} />}
            {isDark ? t('emailActionBar.light') : t('emailActionBar.dark')}
          </Button>
          <Button variant="ghost" icon onClick={onClose} aria-label={t('common.close')} className="flex-shrink-0">
            <X size={20} />
          </Button>
        </div>

        {/* Email Meta */}
        <div className="px-4 py-3 border-b border-mail-border bg-mail-surface space-y-1 text-sm shrink-0 max-h-[30vh] overflow-y-auto">
          <div className="flex gap-2">
            <span className="text-mail-text-muted w-14 flex-shrink-0">{t('email.fullView.from')}</span>
            <span className="text-mail-text min-w-0 break-words">
              {email.from?.name ? `${email.from.name} <${email.from.address}>` : email.from?.address}
            </span>
          </div>
          <div className="flex gap-2">
            <span className="text-mail-text-muted w-14 flex-shrink-0">{t('email.fullView.to')}</span>
            <span className="text-mail-text min-w-0 break-words">
              {email.to?.map(t => t.name ? `${t.name} <${t.address}>` : t.address).join(', ')}
            </span>
          </div>
          <div className="flex gap-2">
            <span className="text-mail-text-muted w-14 flex-shrink-0">{t('email.fullView.date')}</span>
            <span className="text-mail-text">
              {email.date ? formatDateTime(email.date) : ''}
            </span>
          </div>
        </div>

        {/* Email Body - Full Height iframe */}
        <div className="flex-1 min-h-0 overflow-hidden relative" style={{ backgroundColor: emailColors.background }}>
          {!fetchedEmail && loadingEmail ? (
            <div className="absolute inset-0 flex items-center justify-center bg-mail-bg">
              <div className="flex flex-col items-center gap-3">
                <Loader size={32} className="text-mail-accent-text animate-spin" />
                <span className="text-sm text-mail-text-muted">{t('email.fullView.loadingEmailContent')}</span>
              </div>
            </div>
          ) : (
            <iframe
              ref={iframeRef}
              srcDoc={iframeContent}
              className="w-full h-full border-0"
              sandbox="allow-same-origin allow-popups allow-scripts"
              title={t('email.fullView.fullEmailContent')}
            />
          )}
        </div>

        {/* Attachments */}
        {(() => {
          const modalAttachments = getRealAttachments(email.attachments, email.html);
          const modalMailbox = resolveEmailLocation(initialEmail, useMailStore.getState())?.mailbox;
          return modalAttachments.length > 0 ? (
            <div className="px-4 py-3 border-t border-mail-border bg-mail-bg shrink-0 max-h-36 overflow-y-auto">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {modalAttachments.map((att) => (
                  <AttachmentItem
                    key={att._originalIndex}
                    attachment={att}
                    attachmentIndex={att._originalIndex}
                    emailUid={email.uid}
                    accountId={activeAccountId}
                    mailbox={modalMailbox}
                  />
                ))}
              </div>
            </div>
          ) : null;
        })()}
      <LinkSafetyModal
        alert={linkSafetyAlert}
        onCancel={() => setLinkSafetyAlert(null)}
        onOpenAnyway={() => {
          const url = linkSafetyAlert.actualUrl;
          setLinkSafetyAlert(null);
          import('@tauri-apps/plugin-shell').then(({ open }) => open(url)).catch(() => window.open(url, '_blank'));
        }}
      />
    </Dialog>
  );
}
