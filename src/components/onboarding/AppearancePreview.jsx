import React from 'react';
import { Archive, ChevronDown, Cloud, FolderInput, Forward, HardDrive, Inbox, Mail, MailOpen, MoreHorizontal, PenSquare, Reply, ReplyAll, Send, Star, Sun, Moon, Trash2, ImageDown } from 'lucide-react';
import { PREVIEW_ACCOUNTS, previewConversation, previewRows } from '../../data/previewMail';
import { useT } from '../../i18n';
import { getEmailColors } from '../../utils/mailChrome';
import { listRowGround } from '../../utils/listRowGround';
import { SampleConversation } from '../ui/SampleConversation';
import { fontStack } from '../../utils/appFont';

// An isolated illustration. Never mount live readers or seed the mail store.
// The quick actions tab passes `listSlot`: the real, inert rows of
// settings/QuickActionSamples.jsx, in this same window.
// The list's row gutter (RowGutter in EmailRow.jsx), same classes: an
// expandable list reserves the disclosure slot on every row, so the text
// starts at one x whether a row has a chevron or not.
function SampleRow({ row, selected, highlight, singleLine, nested, count, expandable, threadSlot }) {
  return <div className={`onboarding-sample-row ${singleLine ? 'onboarding-sample-single' : ''} ${nested ? 'onboarding-sample-nested' : ''} ${listRowGround({ highlight, selected, unread: row.unread, markedPad: '' })}`}>
    <span data-testid="row-gutter" className={`row-gutter${singleLine ? '' : ' row-gutter-stacked'}`} aria-hidden="true">
      {threadSlot && <span className="row-gutter-slot">{expandable && <ChevronDown size={12} />}</span>}
      <span className="row-gutter-cell">
        <span className="row-gutter-check"><span className="custom-checkbox preview-checkbox" /></span>
        <span className="row-gutter-slot"><Cloud size={12} className="text-mail-server" /></span>
      </span>
    </span>
    <div className="onboarding-sample-row-copy"><strong>{row.sender}{count && <span className="onboarding-sample-count">{count}</span>}</strong><span>{row.subject}</span></div>
    <span className="onboarding-sample-time">{row.time}</span>
  </div>;
}

function SampleToolbar({ display, dark }) {
  const t = useT();
  const actions = [[Reply, 'emailActionBar.reply'], [ReplyAll, 'emailActionBar.replyAll'], [Forward, 'emailActionBar.forward'], [Archive, 'common.archive'], [Trash2, 'common.delete'], [FolderInput, 'emailActionBar.move'], [MailOpen, 'emailActionBar.markUnread'], [Star, 'emailActionBar.star'], [ImageDown, 'common.export']];
  const draw = ([Icon, key], index) => <span key={key} role="img" aria-label={t(key)} className={`email-action-button ${index === 0 ? 'email-action-primary' : ''}`}>
    {display !== 'text-only' && <Icon size={12} aria-hidden="true" />}{display !== 'icon-only' && <span>{t(key)}</span>}
  </span>;
  return <div className="email-action-bar onboarding-sample-actions" data-testid="preview-actions">
    <div className="email-action-main">{actions.map(draw)}</div>
    <div className="email-action-group email-action-tools">{draw([dark ? Sun : Moon, dark ? 'emailActionBar.light' : 'emailActionBar.dark'])}{draw([MoreHorizontal, 'email.sender.more'])}</div>
  </div>;
}

// The sidebar in each layout of Settings → Workspace (Sidebar.jsx): one
// scrolling list, two sections, an account menu, or folders under the account.
function SampleSidebarNav({ layout }) {
  const t = useT();
  const item = (key, active, children) => <span key={key} className={`onboarding-sample-nav-item ${active ? 'onboarding-sample-nav-active' : ''}`}>{children}</span>;
  const account = (account, index) => item(account.id, index === 0, <><i aria-hidden="true">{account.name[0]}</i><span>{account.name}</span></>);
  const folders = [[Inbox, 'sidebar.inbox'], [Archive, 'common.archive'], [Send, 'list.sent']]
    .map(([Icon, key], index) => item(key, index === 0, <><Icon size={13} aria-hidden="true" /><span>{t(key)}</span></>));
  const folderNav = <div className="onboarding-sample-nav onboarding-sample-folder-nav">{folders}</div>;
  if (layout === 'nested') return <div className="onboarding-sample-nav">
    {account(PREVIEW_ACCOUNTS[0], 0)}
    <div className="onboarding-sample-nav onboarding-sample-folder-nav onboarding-sample-nested-folders">{folders}</div>
    {PREVIEW_ACCOUNTS.slice(1).map((a, i) => account(a, i + 1))}
  </div>;
  if (layout === 'switcher') return <>
    <span data-testid="preview-account-switcher" className="onboarding-sample-nav-item onboarding-sample-switcher">
      <i aria-hidden="true">{PREVIEW_ACCOUNTS[0].name[0]}</i><span>{PREVIEW_ACCOUNTS[0].name}</span><ChevronDown size={12} aria-hidden="true" />
    </span>
    {folderNav}
  </>;
  const accounts = <div className="onboarding-sample-nav">{PREVIEW_ACCOUNTS.map(account)}</div>;
  const heading = <span className="onboarding-sample-nav-heading">{t('sidebar.folders')}</span>;
  if (layout === 'split') return <>
    <div className="onboarding-sample-sidebar-section">{accounts}</div>
    <div className="onboarding-sample-sidebar-section">{heading}{folderNav}</div>
  </>;
  return <>{accounts}{heading}{folderNav}</>;
}

export function AppearancePreview({ layoutMode, sidebarStyle, viewStyle, emailListStyle, threadMode = 'grouped', sidebarLayout = 'stacked', theme = 'dark', palette = 'indigo', emailViewerTheme = 'system', highlight = 'hover', actionButtonDisplay = 'icon-label', appFont, listSlot = null }) {
  const t = useT();
  const rows = previewRows();
  const replies = previewConversation();
  const threeColumn = layoutMode === 'three-column';
  const chat = viewStyle === 'chat';
  const singleLine = emailListStyle !== 'compact';
  const threadSlot = threadMode === 'expandable';
  const emailTheme = emailViewerTheme === 'system' ? theme : emailViewerTheme;
  const colors = getEmailColors(emailTheme, palette);
  const thread = { id: 'preview-thread', sender: 'Nell, Rowan', subject: t('settings.preview.subject'), time: replies.at(-1).time };

  return <figure className="onboarding-mail-sample" data-testid="appearance-preview" data-theme={theme} data-palette={palette} style={appFont ? { fontFamily: fontStack(appFont) } : undefined} aria-label={t('onboarding.previewCaption')}>
    <div className="onboarding-sample-app">
      <div data-testid="preview-pane-sidebar" data-style={sidebarStyle} data-layout={sidebarLayout} className={`onboarding-sample-sidebar ${sidebarStyle === 'tagcloud' ? 'onboarding-sample-bubbles' : ''}`}>
        <strong className="onboarding-sample-brand">MailVault</strong>
        <span className="onboarding-sample-compose"><PenSquare size={13} aria-hidden="true" />{t('sidebar.compose')}</span>
        <SampleSidebarNav layout={sidebarLayout} />
      </div>
      <div data-testid="preview-panes" data-layout={listSlot ? 'list' : chat ? 'chat' : layoutMode} className={`onboarding-sample-panes flex ${!listSlot && !chat && threeColumn ? 'flex-row' : 'flex-col'}`}>
        {listSlot ? <div data-testid="preview-list" data-view="quick-actions" className="onboarding-sample-list onboarding-sample-list-wide">
          <strong className="onboarding-sample-list-heading">{t('sidebar.inbox')}</strong>{listSlot}
        </div> : chat ? <div data-testid="preview-chat" className="onboarding-sample-chat"><SampleConversation /></div> : <>
          <div data-testid="preview-list" data-view="list" data-density={emailListStyle} data-threads={threadMode} className="onboarding-sample-list">
            <strong className="onboarding-sample-list-heading">{t('sidebar.inbox')}</strong>
            <SampleRow row={rows[0]} selected highlight={highlight} singleLine={singleLine} threadSlot={threadSlot} />
            {threadMode !== 'flat' && <SampleRow row={thread} count={3} expandable={threadMode === 'expandable'} highlight={highlight} singleLine={singleLine} threadSlot={threadSlot} />}
            {threadMode !== 'grouped' && replies.map(reply => <SampleRow key={reply.id} row={{ ...reply, subject: thread.subject }} nested={threadMode === 'expandable'} highlight={highlight} singleLine={singleLine} threadSlot={threadSlot} />)}
            {rows.slice(1, 4).map(row => <SampleRow key={row.id} row={row} highlight={highlight} singleLine={singleLine} threadSlot={threadSlot} />)}
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
