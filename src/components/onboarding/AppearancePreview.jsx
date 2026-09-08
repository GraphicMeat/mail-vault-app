import React from 'react';
import { Archive, ChevronDown, Cloud, FolderInput, Forward, HardDrive, Inbox, Mail, MoreHorizontal, PenSquare, Reply, ReplyAll, Send, Star, Sun, Moon, Trash2, ImageDown } from 'lucide-react';
import { PREVIEW_ACCOUNTS, previewConversation, previewRows } from '../../data/previewMail';
import { useT } from '../../i18n';
import { getEmailColors } from '../../utils/mailChrome';
import { listRowGround } from '../../utils/listRowGround';
import { SampleConversation } from '../ui/SampleConversation';

// An isolated illustration. Never mount live readers or seed the mail store.
function SampleRow({ row, selected, highlight, singleLine, nested, count, expandable }) {
  return <div className={`onboarding-sample-row ${singleLine ? 'onboarding-sample-single' : ''} ${nested ? 'onboarding-sample-nested' : ''} ${listRowGround({ highlight, selected, unread: row.unread, markedPad: '' })}`}>
    {expandable ? <ChevronDown size={12} aria-hidden="true" /> : <Cloud size={12} className="text-mail-server" aria-hidden="true" />}
    <div className="onboarding-sample-row-copy"><strong>{row.sender}{count && <span className="onboarding-sample-count">{count}</span>}</strong><span>{row.subject}</span></div>
    <span className="onboarding-sample-time">{row.time}</span>
  </div>;
}

function SampleToolbar({ display, dark }) {
  const t = useT();
  const actions = [[Reply, 'emailActionBar.reply'], [ReplyAll, 'emailActionBar.replyAll'], [Forward, 'emailActionBar.forward'], [Archive, 'common.archive'], [Trash2, 'common.delete'], [FolderInput, 'emailActionBar.move'], [Mail, 'emailActionBar.markUnread'], [Star, 'emailActionBar.star'], [ImageDown, 'common.export']];
  const draw = ([Icon, key], index) => <span key={key} role="img" aria-label={t(key)} className={`email-action-button ${index === 0 ? 'email-action-primary' : ''}`}>
    {display !== 'text-only' && <Icon size={12} aria-hidden="true" />}{display !== 'icon-only' && <span>{t(key)}</span>}
  </span>;
  return <div className="email-action-bar onboarding-sample-actions" data-testid="preview-actions">
    <div className="email-action-main">{actions.map(draw)}</div>
    <div className="email-action-group email-action-tools">{draw([dark ? Sun : Moon, dark ? 'emailActionBar.light' : 'emailActionBar.dark'])}{draw([MoreHorizontal, 'email.sender.more'])}</div>
  </div>;
}

export function AppearancePreview({ layoutMode, sidebarStyle, viewStyle, emailListStyle, threadMode = 'grouped', theme = 'dark', palette = 'indigo', emailViewerTheme = 'system', highlight = 'hover', actionButtonDisplay = 'icon-label' }) {
  const t = useT();
  const rows = previewRows();
  const replies = previewConversation();
  const threeColumn = layoutMode === 'three-column';
  const chat = viewStyle === 'chat';
  const singleLine = emailListStyle !== 'compact';
  const emailTheme = emailViewerTheme === 'system' ? theme : emailViewerTheme;
  const colors = getEmailColors(emailTheme, palette);
  const thread = { id: 'preview-thread', sender: 'Nell, Rowan', subject: t('settings.preview.subject'), time: replies.at(-1).time };

  return <figure className="onboarding-mail-sample" data-testid="appearance-preview" data-theme={theme} data-palette={palette} aria-label={t('onboarding.previewCaption')}>
    <div className="onboarding-sample-app">
      <div data-testid="preview-pane-sidebar" data-style={sidebarStyle} className={`onboarding-sample-sidebar ${sidebarStyle === 'tagcloud' ? 'onboarding-sample-bubbles' : ''}`}>
        <strong className="onboarding-sample-brand">MailVault</strong>
        <span className="onboarding-sample-compose"><PenSquare size={13} aria-hidden="true" />{t('sidebar.compose')}</span>
        <div className="onboarding-sample-nav">
          {PREVIEW_ACCOUNTS.map((account, index) => <span key={account.id} className={`onboarding-sample-nav-item ${index === 0 ? 'onboarding-sample-nav-active' : ''}`}>
            <i aria-hidden="true">{account.name[0]}</i><span>{account.name}</span>
          </span>)}
        </div>
        <span className="onboarding-sample-nav-heading">{t('sidebar.folders')}</span>
        <div className="onboarding-sample-nav onboarding-sample-folder-nav">
          {[[Inbox, 'sidebar.inbox'], [Archive, 'common.archive'], [Send, 'list.sent']].map(([Icon, key], index) => <span key={key} className={`onboarding-sample-nav-item ${index === 0 ? 'onboarding-sample-nav-active' : ''}`}><Icon size={13} aria-hidden="true" /><span>{t(key)}</span></span>)}
        </div>
      </div>
      <div data-testid="preview-panes" data-layout={chat ? 'chat' : layoutMode} className={`onboarding-sample-panes flex ${!chat && threeColumn ? 'flex-row' : 'flex-col'}`}>
        {chat ? <div data-testid="preview-chat" className="onboarding-sample-chat"><SampleConversation /></div> : <>
          <div data-testid="preview-list" data-view="list" data-density={emailListStyle} data-threads={threadMode} className="onboarding-sample-list">
            <strong className="onboarding-sample-list-heading">{t('sidebar.inbox')}</strong>
            <SampleRow row={rows[0]} selected highlight={highlight} singleLine={singleLine} />
            {threadMode !== 'flat' && <SampleRow row={thread} count={3} expandable={threadMode === 'expandable'} highlight={highlight} singleLine={singleLine} />}
            {threadMode !== 'grouped' && replies.map(reply => <SampleRow key={reply.id} row={{ ...reply, subject: thread.subject }} nested={threadMode === 'expandable'} highlight={highlight} singleLine={singleLine} />)}
            {rows.slice(1, 4).map(row => <SampleRow key={row.id} row={row} highlight={highlight} singleLine={singleLine} />)}
          </div>
          <div data-testid="preview-pane-viewer" className="onboarding-sample-reader">
            <h3>{rows[0].subject}</h3>
            <div className="onboarding-sample-sender"><strong>{rows[0].sender}</strong><span>{rows[0].time}</span></div>
            <SampleToolbar display={actionButtonDisplay} dark={emailTheme === 'dark'} />
            <div className="onboarding-sample-body" data-email-theme={emailTheme} style={{ backgroundColor: colors.background, color: colors.text }}><p>{rows[0].snippet}</p></div>
          </div>
        </>}
      </div>
    </div>
    <figcaption><span>{t('onboarding.previewCaption')}</span><span><Cloud size={12} className="text-mail-server" aria-hidden="true" />{t('list.serverOnly')}</span><span><HardDrive size={12} className="text-mail-local" aria-hidden="true" />{t('list.vault')}</span></figcaption>
  </figure>;
}
