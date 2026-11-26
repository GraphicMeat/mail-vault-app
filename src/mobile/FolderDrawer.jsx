// The folder drawer. Its head is the account in front, drawn as the list header's account button
// (avatar, name or address, chevron; All Inboxes' glyph and name while All Inboxes is open), and
// opens the account switcher (`onSwitchAccount`). Then the active account's folders, depth first as the engine lists them, with
// unread counts (All Inboxes is picked in the accounts sheet, above the accounts). Special-use folders get their translated name; a folder that cannot be opened
// (`noselect`) is shown as a heading for its children. Names come from `folders.js`. While All
// Inboxes is open (`activeFolder` is ALL_INBOXES) the drawer names no account: All Inboxes is its
// one entry, in place of the address and folders of the account kept in front, as desktop's
// sidebar swaps to its unified list (UnifiedFolderList reads desktop's account store, so it is not
// reused; the engine lists no unified folder but All Inboxes, so the drawer offers none). There is
// one Drafts: when the account has a Drafts folder (`draftsFolder`, folders.js) that folder's row
// counts the phone's local drafts (the folder lists them on top, App.jsx) and carries
// `data-mv-drafts`; otherwise, and in All Inboxes, a Drafts row below the folders (the local
// drafts, with their count) opens the drafts list. Follow up
// (shown while there are follow-up reminders, with the count that found no reply) opens the
// reminders list; in All Inboxes both are every shown account's. The footer's Settings opens the
// settings screen.
// Desktop's saved views (`views`, with their counts) follow the folders, under desktop's Views
// heading and each with desktop's icon, as on desktop's sidebar: a tap opens the view's mail
// (ViewResults.jsx). The heading carries desktop's Edit and New (`onEditViews`, `onNewView`: Settings
// > Views, the second on a new view), shown with no view as on desktop.
// Every row wears desktop's glyph at 16px: a folder its mailbox glyph (src/utils/mailboxIcon.js,
// desktop FolderTree's), Drafts, Follow up and Settings those desktop's sidebar gives them.
import React from 'react';
import { Bell, File, Pencil, Plus, Settings } from 'lucide-react';
import Sheet from './Sheet.jsx';
import { useT } from './i18n.js';
import { folderLabel, iconMailbox, draftsFolder, ALL_INBOXES } from './folders.js';
import { Avatar } from './AccountSwitcher.jsx';
import { AllInboxesIcon, ChevronDownIcon } from './icons.jsx';
import { getMailboxIcon } from '../utils/mailboxIcon.js';
import { ViewIcon } from '../components/ViewIcon.jsx';
import { viewLabel } from '../utils/viewLabel.js';
import { Button } from '../components/ui/Button.jsx';

function FolderGlyph({ folder }) {
  const Icon = getMailboxIcon(iconMailbox(folder));
  return <span className="mv-folder__icon"><Icon size={16} aria-hidden="true" /></span>;
}

function DrawerHead({ account, allInboxes, onSwitchAccount }) {
  const t = useT();
  if (!account && !allInboxes) return null;
  const name = account?.displayName && account.displayName !== account.email ? account.displayName : account?.email;
  return (
    <Button
      variant="ghost"
      size="touch"
      className="mv-drawer__account justify-start"
      aria-label={t('mobile.switcher.open', { email: allInboxes ? t('sidebar.allInboxes') : account.email })}
      onClick={onSwitchAccount}
    >
      {allInboxes ? (
        <span className="mv-avatar mv-avatar--small mv-avatar--all" aria-hidden="true"><AllInboxesIcon size={14} /></span>
      ) : (
        <Avatar account={account} small />
      )}
      <span className="mv-header__email" dir="auto">{allInboxes ? t('sidebar.allInboxes') : name}</span>
      <ChevronDownIcon className="mv-header__chevron" />
    </Button>
  );
}

export default function FolderDrawer({ account, folders, activeFolder, onSelect, onClose, onSwitchAccount, drafts = 0, onDrafts, followUps = 0, followUpsDue = 0, onFollowUps, onSettings, views = [], viewCounts = {}, onView, onEditViews, onNewView }) {
  const t = useT();
  const allInboxes = activeFolder === ALL_INBOXES;
  // The account's Drafts folder is the one Drafts: the local drafts are counted on it.
  const draftsPath = allInboxes ? null : draftsFolder(folders)?.path ?? null;
  return (
    <Sheet kind="drawer" label={t('mobile.drawer.title')} onClose={onClose}>
      <div className="mv-drawer__head">
        <DrawerHead account={account} allInboxes={allInboxes} onSwitchAccount={onSwitchAccount} />
      </div>
      {allInboxes ? (
        <ul className="mv-folders">
          <li>
            <button type="button" className="mv-folder mv-folder--active" aria-current="true" data-mv-drawer-all-inboxes onClick={onClose}>
              <span className="mv-folder__icon"><AllInboxesIcon size={16} /></span>
              <span className="mv-folder__name">{t('sidebar.allInboxes')}</span>
            </button>
          </li>
        </ul>
      ) : folders.length === 0 ? (
        <p className="mv-drawer__empty">{t('mobile.drawer.empty')}</p>
      ) : (
        <ul className="mv-folders">
          {folders.map((f) => {
            const style = { paddingInlineStart: `calc(16px + ${Math.min(f.depth || 0, 6) * 16}px)` };
            if (f.noselect) {
              return (
                <li key={f.path} className="mv-folder mv-folder--heading" style={style} dir="auto">{folderLabel(f)}</li>
              );
            }
            const active = f.path === activeFolder;
            const localDrafts = f.path === draftsPath && drafts > 0;
            return (
              <li key={f.path}>
                <button
                  type="button"
                  className={active ? 'mv-folder mv-folder--active' : 'mv-folder'}
                  style={style}
                  aria-current={active ? 'true' : undefined}
                  data-mv-drafts={f.path === draftsPath ? true : undefined}
                  onClick={() => onSelect(f.path)}
                >
                  <FolderGlyph folder={f} />
                  <span className="mv-folder__name" dir="auto">{folderLabel(f)}</span>
                  {localDrafts ? (
                    <span className="mv-folder__count" aria-label={t('mobile.drafts.count', { count: drafts })}>{drafts}</span>
                  ) : f.unseen > 0 && (
                    <span className="mv-folder__count" aria-label={t('mobile.unreadCount', { count: f.unseen })}>{f.unseen}</span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {onView && (views.length > 0 || onEditViews || onNewView) && (
        <div className="mv-drawer__local mv-drawer__views" data-mv-views>
          <div className="mv-drawer__heading-row">
            <h3 className="mv-drawer__heading">{t('views.section')}</h3>
            {onEditViews && (
              <Button variant="ghost" size="touch" icon data-mv-views-edit aria-label={t('views.edit')} title={t('views.edit')} onClick={onEditViews}>
                <Pencil size={16} aria-hidden="true" />
              </Button>
            )}
            {onNewView && (
              <Button variant="ghost" size="touch" icon data-mv-views-new aria-label={t('views.new')} title={t('views.new')} onClick={onNewView}>
                <Plus size={16} aria-hidden="true" />
              </Button>
            )}
          </div>
          {views.map((v) => (
            <button key={v.id} type="button" className="mv-folder" data-mv-view-open={v.id} onClick={() => onView(v)}>
              <span className="mv-folder__icon"><ViewIcon icon={v.icon} size={16} /></span>
              <span className="mv-folder__name" dir="auto">{viewLabel(v, t)}</span>
              {viewCounts[v.id] > 0 && <span className="mv-folder__count">{viewCounts[v.id]}</span>}
            </button>
          ))}
        </div>
      )}
      {onDrafts && !draftsPath && (
        <div className="mv-drawer__local">
          <button type="button" className="mv-folder" data-mv-drafts onClick={onDrafts}>
            <span className="mv-folder__icon"><File size={16} aria-hidden="true" /></span>
            <span className="mv-folder__name">{t('mobile.drafts.title')}</span>
            {drafts > 0 && (
              <span className="mv-folder__count" aria-label={t('mobile.drafts.count', { count: drafts })}>{drafts}</span>
            )}
          </button>
        </div>
      )}
      {onFollowUps && followUps > 0 && (
        <div className="mv-drawer__local">
          <button type="button" className="mv-folder" data-mv-followups-open onClick={onFollowUps}>
            <span className="mv-folder__icon"><Bell size={16} aria-hidden="true" /></span>
            <span className="mv-folder__name">{t('mobile.followUp.title')}</span>
            {followUpsDue > 0 && (
              <span className="mv-folder__count" aria-label={t('mobile.followUp.count', { count: followUpsDue })}>{followUpsDue}</span>
            )}
          </button>
        </div>
      )}
      {onSettings && (
        <div className="mv-drawer__local mv-drawer__footer">
          <button type="button" className="mv-folder" data-mv-settings onClick={onSettings}>
            <span className="mv-folder__icon"><Settings size={16} aria-hidden="true" /></span>
            <span className="mv-folder__name">{t('mobile.settings.title')}</span>
          </button>
        </div>
      )}
    </Sheet>
  );
}
