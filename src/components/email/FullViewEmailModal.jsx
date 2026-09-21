import React, { useMemo, useRef, useEffect, useState } from 'react';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { useAccountStore } from '../../stores/accountStore';
import { useMailStore } from '../../stores/mailStore';
import { resolveEmailLocation, emailScopeKey, spansMailboxes, rowKey, selectionKey } from '../../stores/slices/unifiedHelpers';
import { useSelectionStore } from '../../stores/selectionStore';
import { useSettingsStore, isTrackerBlockingActive } from '../../stores/settingsStore';
import { useThemeStore } from '../../stores/themeStore';
import { getEmailColors } from '../../utils/mailChrome';
import { getDarkReaderInlineScripts } from '../../utils/darkReaderInject';
import { formatDateTime } from '../../utils/dateFormat';
import { X, Loader } from 'lucide-react';
import { AttachmentItem } from '../EmailViewer';
import { DownloadAllButton } from './AttachmentBar';
import { getRealAttachments, replaceCidUrls } from '../../services/attachmentUtils';
import { checkLinkAlert } from '../../utils/linkSafety';
import { scanTrackers } from '../../utils/trackerDetect';
import { recordTrackerVerdict } from '../../services/trackerVerdicts';
import { LinkSafetyModal } from '../LinkSafetyModal';
import { openMailtoCompose, plainTextBodyHtml } from '../../utils/mailto';
import { buildEmailIframeHtml, getEmailBodyContent, emailScriptNonce } from '../../utils/emailIframeTemplate';
import { useSearchHighlight } from '../../hooks/useSearchHighlight';
import { t as tr, useT  } from '../../i18n/index.js';
import { getSelectionGeneration } from '../../services/workflows/selectEmail';
import { EmailActionBar } from './EmailActionBar';
import { TagChips } from '../TagChips';
import { FieldStrip } from '../FieldStrip';
import { MoveToFolderDropdown } from '../MoveToFolderDropdown';
import { DeleteConfirmModal } from '../DeleteConfirmModal';
import { describePurge } from '../../utils/custodyCopy';
import { useExportStore } from '../../stores/exportStore';
import { openCompose } from '../../utils/composeOpener';
import { replyTarget } from '../../utils/replyTarget';
import { replySelection } from '../../utils/replySelection';
import { isBackedUp as isEmailBackedUp } from './MessageStateIcon';
import { applyFlagToKeys, purgeEverywhere } from '../../services/workflows/messageMutations';

// Full-screen modal for viewing complete email with HTML rendering
export function FullViewEmailModal({ email: initialEmail, onClose }) {
  const t = useT();
  const selectEmail = useSelectionStore(s => s.selectEmail);
  const selectedEmail = useSelectionStore(s => s.selectedEmail);
  const loadingEmail = useSelectionStore(s => s.loadingEmail);
  const activeAccountId = useAccountStore(s => s.activeAccountId);
  const activeMailbox = useAccountStore(s => s.activeMailbox);
  const backedUpKeys = useMailStore(s => s.backedUpKeys);
  const backedUpScopes = useMailStore(s => s.backedUpScopes);
  const backupConfigured = useMailStore(s => s.backupConfigured);
  const iframeRef = useRef(null);
  const selectedReplyHtml = () => {
    const frame = iframeRef.current;
    return replySelection(frame?.contentDocument?.body, frame?.contentWindow?.getSelection?.());
  };
  const [fetchedEmail, setFetchedEmail] = useState(null);
  const selectionOwnership = useRef(null);
  const [linkSafetyAlert, setLinkSafetyAlert] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [showMoveDropdown, setShowMoveDropdown] = useState(false);
  const moveButtonRef = useRef(null);
  const linkSafetyEnabled = useSettingsStore(s => s.linkSafetyEnabled);
  const trackerBlocking = useSettingsStore(isTrackerBlockingActive);
  const appTheme = useThemeStore(s => s.theme);
  const palette = useThemeStore(s => s.palette);
  const emailViewerTheme = useSettingsStore(s => s.emailViewerTheme);
  const [themeOverride, setThemeOverride] = useState(null);
  const theme = themeOverride ?? (emailViewerTheme === 'system' ? appTheme : emailViewerTheme);
  const isDark = theme === 'dark';
  const emailColors = getEmailColors(theme, palette);
  const close = () => {
    const owned = selectionOwnership.current;
    const state = useMailStore.getState();
    const currentView = state.activeAccountId === owned?.accountId
      && state.activeMailbox === owned?.activeMailbox
      && state.mailboxScope === owned?.mailboxScope;
    const currentSelection = state.selectedEmailId;
    const currentReader = currentSelection == null
      || currentSelection === owned?.selectionId
      || currentSelection === owned?.previousSelectionId;
    if (owned && getSelectionGeneration() === owned.generation && currentView && currentReader) {
      // closeEmail performs the generation invalidation and clears loadingEmail
      // for this modal's own fetch. If another reader superseded it, the
      // ownership checks above leave that reader untouched.
      state.closeEmail();
    }
    onClose?.();
  };
  const initialLocation = resolveEmailLocation(initialEmail, useMailStore.getState());
  const initialIdentity = JSON.stringify([initialLocation?.accountId || initialEmail?._accountId || null, initialLocation?.mailbox || initialEmail?._mailbox || null, String(initialEmail?.uid)]);
  useEffect(() => {
    setFetchedEmail(null);
    setThemeOverride(null);
    setPendingDelete(null);
    setShowMoveDropdown(false);
    selectionOwnership.current = null;
  }, [initialIdentity]);
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

      // Need to fetch full content - use selectEmail. A bare uid names no
      // message in a spanning view.
      try {
        const opened = useMailStore.getState();
        const selectionId = rowKey(initialEmail, spansMailboxes(opened));
        const selection = selectEmail(selectionId, initialEmail.source || 'server');
        selectionOwnership.current = {
          generation: getSelectionGeneration(),
          accountId: opened.activeAccountId,
          activeMailbox: opened.activeMailbox,
          mailboxScope: opened.mailboxScope,
          selectionId,
          previousSelectionId: opened.selectedEmailId,
        };
        await selection;
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
    const state = useMailStore.getState();
    const selectedLocation = selectedEmail && resolveEmailLocation(selectedEmail, state);
    const sameTarget = selectedEmail && String(selectedEmail.uid) === String(initialEmail.uid)
      && initialLocation && selectedLocation
      && selectedLocation.accountId === initialLocation.accountId
      && selectedLocation.mailbox === initialLocation.mailbox;
    if (sameTarget) {
      setFetchedEmail(selectedEmail);
    }
  }, [selectedEmail, initialIdentity]);

  // Use fetched email or fall back to initial
  const email = fetchedEmail || initialEmail;
  const emailLocation = resolveEmailLocation(email, useMailStore.getState());
  const emailKey = selectionKey(email, useMailStore.getState());
  const isArchived = !!email?.isArchived;
  const isLocalOnly = email?.source === 'local-only' || email?._origin === 'local-only';
  const isSentEmail = emailLocation?.mailbox?.toLowerCase() === 'sent' || email?.flags?.includes('\\Sent');
  const backupScan = { backedUpKeys, backedUpScopes, backupConfigured, activeAccountId, activeMailbox };
  const backupEmail = emailLocation
    ? { ...email, _accountId: emailLocation.accountId, _mailbox: emailLocation.mailbox }
    : email;
  const isBackedUp = isEmailBackedUp(backupEmail, backupScan) === true;
  const purgeDescription = describePurge({ server: !isLocalOnly, vault: isArchived || isLocalOnly, backup: isBackedUp }, 1);
  const requestDelete = (target = email) => {
    const state = useMailStore.getState();
    const location = resolveEmailLocation(target, state);
    if (!location) return;
    const explicitLocation = { accountId: location.accountId, mailbox: location.mailbox };
    const localOnly = target.source === 'local-only' || target._origin === 'local-only';
    setPendingDelete({
      // Removing the only copy is not undoable — that one always asks.
      confirmOptional: !localOnly,
      executor: () => localOnly
        ? useMailStore.getState().removeLocalEmail(target.uid, explicitLocation)
        : useMailStore.getState().deleteEmailFromServer(target.uid, { accountId: explicitLocation.accountId, mailboxOverride: explicitLocation.mailbox }),
      copy: {
        title: t('viewer.deleteEmail'),
        description: localOnly ? t('viewer.emailOnlyExistsLocalArchive') : target.isArchived ? t('viewer.emailArchivedLocallyDeletingServer') : t('viewer.emailPermanentlyDeletedServer'),
        confirmLabel: t('common.delete'),
      },
    });
  };

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
    // One nonce per render: the frame's CSP runs only our nonced DR script, not
    // anything the mail carries.
    const nonce = emailScriptNonce();
    return buildEmailIframeHtml({
      bodyHtml: getEmailBodyContent(scannedForFrame),
      themeTag: theme,
      extraHead: isDark ? getDarkReaderInlineScripts({ palette, nonce }) : '',
      nonce,
    });
  }, [email, trackerBlocking, theme, palette]);

  // Intercept links and prevent native context menu in full-view iframe
  // The full-view window is a third reader of the same body — the highlight
  // follows the message, not the pane it is drawn in.
  useSearchHighlight(iframeRef, iframeContent);

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
    <>
    <Dialog
      open={Boolean(email)}
      onClose={close}
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
          <Button variant="ghost" icon onClick={close} aria-label={t('common.close')} className="flex-shrink-0">
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

        <div className="px-3 py-2 border-b border-mail-border bg-mail-bg shrink-0">
          <TagChips email={email} />
          <FieldStrip email={email} />
          <EmailActionBar email={email} variant="single"
            onReply={async target => openCompose({ mode: 'reply', replyTo: await replyTarget(target, null, useMailStore.getState(), selectedReplyHtml()) })}
            onReplyAll={async target => openCompose({ mode: 'replyAll', replyTo: await replyTarget(target, null, useMailStore.getState(), selectedReplyHtml()) })}
            onForward={async target => openCompose({ mode: 'forward', replyTo: await replyTarget(target, null, useMailStore.getState()) })}
            onArchive={target => {
              if (target.isArchived) {
                const location = resolveEmailLocation(target, useMailStore.getState());
                if (!location) return;
                setPendingDelete({ executor: () => useMailStore.getState().removeLocalEmail(target.uid, { accountId: location.accountId, mailbox: location.mailbox }),
                  copy: { title: t('viewer.unarchiveEmail'), description: isLocalOnly ? t('viewer.emailOnlyExistsLocalArchive') : t('viewer.cachedCopyRemovedEmailStill'), confirmLabel: t('rowMenu.unarchive') } });
              }
              else return useMailStore.getState().saveEmailsLocally([target]);
            }}
            onDelete={requestDelete}
            onMove={() => setShowMoveDropdown(value => !value)}
            onToggleRead={async (target, desired) => {
              const read = !!target.flags?.includes('\\Seen');
              const nextRead = typeof desired === 'boolean' ? desired : !read;
              await applyFlagToKeys([selectionKey(target, useMailStore.getState())], '\\Seen', nextRead);
            }}
            onToggleFlag={target => useMailStore.getState().toggleFlagged(selectionKey(target, useMailStore.getState()))}
            onDeleteEverywhere={purgeDescription && emailLocation ? target => {
              const purge = describePurge({ server: !isLocalOnly, vault: !!target.isArchived || isLocalOnly, backup: isBackedUp }, 1);
              if (!purge) return;
              const key = selectionKey(target, useMailStore.getState());
              setPendingDelete({ executor: () => purgeEverywhere([key]), copy: { title: purge.title, description: purge.description, confirmLabel: purge.label } });
            } : null}
            onExport={target => useExportStore.getState().openExport({ messages: [target] })}
            onToggleEmailTheme={() => setThemeOverride(isDark ? 'light' : 'dark')}
            emailThemeDark={isDark} isArchived={isArchived} isRead={!!email.flags?.includes('\\Seen')}
            isLocalOnly={isLocalOnly} isSentEmail={isSentEmail} singleRecipient={(email.to || []).length <= 1 && !(email.cc?.length > 0)}
            disabled={{ archive: !emailLocation, delete: !emailLocation }}
            moveButtonRef={moveButtonRef} moveDropdownOpen={showMoveDropdown} />
          {showMoveDropdown && <MoveToFolderDropdown uids={[emailKey]} accountId={emailLocation?.accountId}
            currentMailbox={emailLocation?.mailbox} anchorRect={moveButtonRef.current?.getBoundingClientRect()}
            returnFocusRef={moveButtonRef}
            onMove={targetPath => useMailStore.getState().moveEmails([emailKey], targetPath)}
            onClose={() => setShowMoveDropdown(false)} />}
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
          const modalMailbox = emailLocation?.mailbox;
          return modalAttachments.length > 0 ? (
            <div className="px-4 py-3 border-t border-mail-border bg-mail-bg shrink-0 max-h-36 overflow-y-auto">
              {modalAttachments.length > 1 && (
                <div className="flex justify-end mb-2">
                  <DownloadAllButton
                    attachments={modalAttachments}
                    emailUid={email.uid}
                    accountId={emailLocation?.accountId || activeAccountId}
                    mailbox={modalMailbox}
                    subject={email.subject}
                  />
                </div>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {modalAttachments.map((att, i) => (
                  <AttachmentItem
                    key={att._originalIndex}
                    listIndex={i}
                    attachment={att}
                    attachmentIndex={att._originalIndex}
                    emailUid={email.uid}
                    accountId={emailLocation?.accountId || activeAccountId}
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
    <DeleteConfirmModal pending={pendingDelete} onClose={() => setPendingDelete(null)} />
    </>
  );
}
