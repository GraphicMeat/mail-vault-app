import { useCallback } from 'react';
import { ANONYMOUS_LOGS_FILENAME, anonymousLogsAttachment } from '../../utils/anonymousLogs';
import { invoke } from '@tauri-apps/api/core';
import { version } from '../../../package.json';
import { t as tr } from '../../i18n/index.js';

export function useComposePrefills({ setComposeState, setShowBugModal, accounts, activeAccountId }) {
  const composeBugEmail = useCallback(async () => {
    // Read before the window opens, so the logs ride along from the first
    // frame. Null (no shell, unreadable log) opens the report without them.
    const logs = await anonymousLogsAttachment(invoke);
    const os = navigator.platform || navigator.userAgent || 'Unknown';
    const accountCount = accounts.length;
    const activeAccount = accounts.find(a => a.id === activeAccountId);
    const activeProvider = activeAccount?.oauth2Provider || 'password';

    // The compose editor renders this as HTML, so the template has to be HTML —
    // a \n-separated string collapses into one unreadable line.
    const esc = (v) => String(v).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    const section = (title, ...lines) =>
      `<p><strong>${title}</strong></p><p>${lines.join('<br>')}</p>`;

    setComposeState({
      // Marks this window for the cooldown stamp below: the report is filed
      // when the email actually SENDS, not when compose merely opens.
      bugReport: true,
      initialData: {
        to: 'prime@graphicmeat.com',
        subject: `[Bug Report] MailVault v${version}`,
        ...(logs ? { attachments: [logs] } : {}),
        body: [
          section('System info (auto-collected)',
            `App version: ${esc(version)}`,
            `Platform: ${esc(os)}`,
            `Accounts: ${accountCount}`,
            `Active provider: ${esc(activeProvider)}`,
            ...(logs ? [`Logs: attached as ${ANONYMOUS_LOGS_FILENAME} (email addresses masked)`] : [])),
          section('What happened?', '&nbsp;'),
          section('Steps to reproduce', '1.', '2.', '3.'),
          section('What you expected instead', '&nbsp;'),
        ].join('')
      }
    });
    setShowBugModal(false);
  }, [accounts, activeAccountId]);

  const handleReferFriend = useCallback(() => {
    setComposeState({
      initialData: {
        subject: tr('app.shouldTryMailvault'),
        body: [
          // Prose goes through the catalog; the markup stays literal, so a
          // translator receives sentences rather than HTML to preserve.
          `<p>${tr('referral.intro')}</p>`,
          `<p>${tr('referral.what')}</p>`,
          '<ul>',
          `<li><strong>${tr('referral.ownDiskTitle')}</strong> ${tr('referral.ownDiskBody')}</li>`,
          `<li><strong>${tr('referral.confidenceTitle')}</strong> ${tr('referral.confidenceBody')}</li>`,
          `<li><strong>${tr('referral.offlineTitle')}</strong> ${tr('referral.offlineBody')}</li>`,
          `<li><strong>${tr('referral.anyImapTitle')}</strong> ${tr('referral.anyImapBody')}</li>`,
          `<li><strong>${tr('referral.freeTitle')}</strong> ${tr('referral.freeBody')}</li>`,
          '</ul>',
          '<p><a href="https://mailvaultapp.com">https://mailvaultapp.com</a></p>',
        ].join('')
      }
    });
  }, [setComposeState]);

  return { composeBugEmail, handleReferFriend };
}
