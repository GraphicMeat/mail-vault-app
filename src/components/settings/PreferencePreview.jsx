import React from 'react';
import { previewRows } from '../../data/previewMail';
import { SampleConversation } from '../ui/SampleConversation';
import { Archive, ChevronDown, Cloud, FileText, Folder, Inbox, MousePointer2, Reply, Send } from 'lucide-react';
import { useT } from '../../i18n';
import { useThemeStore } from '../../stores/themeStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { getEmailColors } from '../../utils/mailChrome';
import { formatDateOnly, formatTime } from '../../utils/dateFormat';
import { listRowGround } from '../../utils/listRowGround';
import '../../styles/sidebar-layout-previews.css';

// Draw only illustrative content. These examples never mount a real mail
// component or put sample messages into the user's accounts or mail stores.
const SAMPLE_DATE = new Date(2026, 1, 25, 14, 30);
const FIRST_REPLY = new Date(2026, 1, 25, 9, 15);

export function PreviewFrame({ label, children, note }) {
  const t = useT();
  return <figure className="preference-preview" aria-label={t('settings.preview.exampleOf', { setting: label })}>
    <figcaption>{note || t('settings.preview.example')}</figcaption>
    <div className="preference-preview-content">{children}</div>
  </figure>;
}

/** Both unselected and selected color choices show their own real tokens. */
export function ColorOptionPreview({ theme, palette }) {
  const t = useT();
  return <span className="color-option-preview" data-theme={theme} data-palette={palette} aria-hidden="true">
    <span className="color-preview-rail"><Inbox aria-hidden="true" size={14} /><Folder aria-hidden="true" size={14} /></span>
    <span className="color-preview-mail">
      <span className="color-preview-title">Nell Okafor</span>
      <span className="color-preview-subject">{t('settings.preview.subject')}</span>
      <span className="color-preview-second">Priya Raines</span>
    </span>
  </span>;
}

export function EmailThemePreview() {
  const t = useT();
  const { theme, palette } = useThemeStore();
  const preference = useSettingsStore(s => s.emailViewerTheme);
  const effectiveTheme = preference === 'system' ? theme : preference;
  const colors = getEmailColors(effectiveTheme, palette);
  return <PreviewFrame label={t('settings.appearance.emailViewerTheme')}>
    <div className="preview-email-header"><strong>Nell Okafor</strong><span>{formatTime(SAMPLE_DATE)}</span></div>
    <div className="preview-email-body" data-email-theme={effectiveTheme} style={{ backgroundColor: colors.background, color: colors.text }}>
      <strong>{t('settings.preview.subject')}</strong>
      <p>{t('settings.preview.question')}</p>
    </div>
  </PreviewFrame>;
}

function SampleRows({ singleLine = false }) {
  const t = useT();
  return <div className={`preview-message-rows ${singleLine ? 'preview-single-line' : ''}`}>
    {['Nell Okafor', 'Priya Raines'].map((sender, index) => <div className="preview-message-row" key={sender}>
      <Cloud aria-hidden="true" size={13} className="text-mail-server" />
      <span className="preview-message-copy"><strong>{sender}</strong><span>{t(index ? 'preview.row4.subject' : 'settings.preview.subject')}</span></span>
      <span className="preview-time">{formatTime(index ? FIRST_REPLY : SAMPLE_DATE)}</span>
    </div>)}
  </div>;
}

function PanePreview({ below = false, chat = false }) {
  const t = useT();
  if (chat) return <SampleConversation compact />;
  return <div className={`preview-mail-layout ${below ? 'preview-mail-below' : ''}`}>
    <div className="preview-mail-list"><span className="preview-pane-label">{t('workspace.messages')}</span><SampleRows singleLine={below} /></div>
    <div className="preview-mail-reader"><span className="preview-pane-label">{t('workspace.readingPane')}</span><strong>{t('settings.preview.subject')}</strong><p>{t('settings.preview.question')}</p></div>
  </div>;
}

export function WorkspacePreview({ setting, value, label, disabled }) {
  const t = useT();
  const layoutMode = useSettingsStore(s => s.layoutMode);
  let content;
  if (setting === 'viewStyle' || setting === 'layoutMode') {
    content = <PanePreview chat={setting === 'viewStyle' && value === 'chat'} below={(setting === 'layoutMode' ? value : layoutMode) === 'two-column'} />;
  } else if (setting === 'sidebarStyle') {
    content = <div className={`preview-navigation ${value === 'tagcloud' ? 'preview-navigation-bubbles' : ''}`}>
      <div><span className="preview-pane-label">{t('workspace.accounts')}</span><span className="preview-nav-item preview-nav-active"><span className="preview-account-initial">P</span>Prime Cut Studio</span><span className="preview-nav-item"><span className="preview-account-initial">R</span>Rowan Marsh</span></div>
      <div className="preview-folder-navigation"><span className="preview-pane-label">{t('sidebar.folders')}</span><span className="preview-nav-item preview-nav-active"><Inbox aria-hidden="true" size={13} />{t('sidebar.inbox')}</span><span className="preview-nav-item"><Archive aria-hidden="true" size={13} />{t('common.archive')}</span><span className="preview-nav-item"><Send aria-hidden="true" size={13} />{t('list.sent')}</span></div>
    </div>;
  } else {
    content = <SampleRows singleLine={value === 'default'} />;
  }
  return <PreviewFrame label={label} note={disabled ? t('settings.preview.savedEmailLayout') : undefined}>{content}</PreviewFrame>;
}

/** A bounded sidebar sample for each choice, visible even before selecting it. */
export function SidebarLayoutPreview({ layout }) {
  const t = useT();
  const folders = [
    [Inbox, 'sidebar.inbox'], [Archive, 'common.archive'], [Send, 'list.sent'],
    [FileText, 'sidebar.drafts'], [Folder, 'sidebar.folders'],
  ];
  const accountRows = ['Prime Cut Studio', 'Rowan Marsh', 'Studio Accounts', 'Nell Okafor', 'Priya Raines'];
  return <span className={`sidebar-layout-sample sidebar-layout-sample-${layout}`} data-sidebar-layout-preview={layout} aria-hidden="true">
    <span className="sidebar-layout-sample-header">MailVault<span>···</span></span>
    <span className="sidebar-layout-sample-body">
      {layout === 'switcher' ? <span className="sidebar-layout-sample-switcher">
        <span className="sidebar-layout-sample-avatar">P</span><span>Prime Cut Studio</span><ChevronDown size={13} />
      </span> : <span className="sidebar-layout-sample-accounts sidebar-layout-sample-scroll">
        <span className="sidebar-layout-sample-heading">{t('workspace.accounts')}</span>
        {accountRows.map((name, index) => <span className={`sidebar-layout-sample-row ${index === 0 ? 'sidebar-layout-sample-active' : ''}`} key={name}>
          <span className="sidebar-layout-sample-avatar">{name[0]}</span><span>{name}</span>
        </span>)}
      </span>}
      <span className="sidebar-layout-sample-folders sidebar-layout-sample-scroll">
        <span className="sidebar-layout-sample-heading">{t('sidebar.folders')}</span>
        {folders.map(([Icon, key], index) => <span className={`sidebar-layout-sample-row ${index === 0 ? 'sidebar-layout-sample-active' : ''}`} key={key}>
          <Icon size={13} /><span>{t(key)}</span>
        </span>)}
      </span>
    </span>
  </span>;
}

export function ReadingPreview({ setting, value, label }) {
  const t = useT();
  let content;
  if (setting === 'threadMode') {
    content = <div className="preview-thread-list">
      {value !== 'flat' && <div className="preview-thread-summary">{value === 'expandable' && <ChevronDown aria-hidden="true" size={14} />}<strong>Nell, Rowan</strong><span>{t('settings.preview.subject')}</span><span className="preview-count">3</span></div>}
      {value !== 'grouped' && <div className={value === 'expandable' ? 'preview-thread-members' : ''}>
        {['Nell', 'Rowan', 'Nell'].map((sender, index) => <div className="preview-thread-message" key={index}><Cloud aria-hidden="true" size={13} className="text-mail-server" /><strong>{sender}</strong><span>{t('settings.preview.subject')}</span></div>)}
      </div>}
      {value === 'grouped' && <div className="preview-thread-message"><strong>Priya</strong><span>{t('preview.row4.subject')}</span></div>}
    </div>;
  } else if (setting === 'threadSortOrder') {
    const messages = [{ sender: 'Nell', text: 'question', date: FIRST_REPLY }, { sender: 'Rowan', text: 'answer', date: SAMPLE_DATE }];
    if (value === 'newest-first') messages.reverse();
    content = <div className="preview-conversation">{messages.map(message => <div key={message.sender} className="preview-reply"><div><strong>{message.sender}</strong><span>{formatTime(message.date)}</span></div><p>{t(`settings.preview.${message.text}`)}</p></div>)}</div>;
  } else if (setting === 'signatureDisplay') {
    content = <div className="preview-signatures">{['question', 'followup'].map((text, index) => {
      const visible = value === 'always-show' || (value === 'smart' && index === 0);
      return <div className="preview-reply" key={text}><div><strong>Nell Okafor</strong><span>{formatTime(index ? SAMPLE_DATE : FIRST_REPLY)}</span></div><p>{t(`settings.preview.${text}`)}</p>
        {visible ? <div className="preview-signature">Nell Okafor<br />Prime Cut Studio</div> : value !== 'always-hide' && <span className="preview-signature-toggle">— {t('util.iframeQuoteFolding.showSignature')}</span>}
      </div>;
    })}</div>;
  } else if (setting === 'emailRowHighlight') {
    content = <div className="preview-highlight">
      <div className={`preview-highlight-row ${listRowGround({ highlight: value, selected: true, markedPad: '', restPad: '' })}`}><strong>Nell Okafor</strong><span>{t('settings.preview.openMessage')}</span></div>
      <div className={`preview-highlight-row ${value === 'hover' ? 'bg-mail-surface-hover' : ''}`}><strong>Priya Raines</strong><span>{t('settings.preview.pointerHere')}<MousePointer2 aria-hidden="true" size={15} /></span></div>
    </div>;
  } else {
    content = <div className="preview-actions">{[[Reply, 'emailActionBar.reply'], [Archive, 'common.archive']].map(([Icon, key], index) => <span key={key} role="img" aria-label={t(key)} className={`email-action-button ${index === 0 ? 'email-action-primary' : ''}`}>
      {value !== 'text-only' && <Icon aria-hidden="true" size={15} />}{value !== 'icon-only' && <span>{t(key)}</span>}
    </span>)}</div>;
  }
  return <PreviewFrame label={label}>{content}</PreviewFrame>;
}

export function DateTimePreview({ time = false, label }) {
  // The parent subscribes to formatting preferences. Use the same formatters
  // as the reader, including the selected language and invalid-pattern fallback.
  const formatted = time ? formatTime(SAMPLE_DATE) : formatDateOnly(SAMPLE_DATE, { alwaysShowYear: true });
  return <PreviewFrame label={label}><div className="preview-date"><span>Nell Okafor</span><strong>{formatted}</strong></div></PreviewFrame>;
}

export function AfterDeletePreview({ value }) {
  const t = useT();
  const next = previewRows()[1];
  return <figure className="onboarding-after-delete-sample" aria-label={t('settings.behavior.afterDeleting')}>
    <figcaption>{t('settings.preview.example')}</figcaption>
    {value === 'next' ? <p><strong>{next.sender}</strong><br />{next.subject}</p> : <p><FileText size={15} aria-hidden="true" />{t('viewer.selectEmailRead')}</p>}
  </figure>;
}
