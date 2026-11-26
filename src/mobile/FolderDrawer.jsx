// The folder drawer. Its head is the account in front, drawn as the list header's account button
// (avatar, name or address, chevron; All Inboxes' glyph and name while All Inboxes is open), and
// opens the account switcher (`onSwitchAccount`); an account with an issue wears the warning dot.
// Then the active account's folders, depth first as the engine lists them, with unread counts
// (All Inboxes is picked in the accounts sheet, above the accounts). Special-use folders get their
// translated name; a folder that cannot be opened (`noselect`) is shown as a heading for its
// children. Names come from `folders.js`, glyphs and their colours from drawer/ (desktop's mailbox
// icon in desktop's folder colour, over the phone's `folderIconStyle` and `folderIconColors`);
// holding a folder offers the colour palette (drawer/FolderColorSheet.jsx).
// While All Inboxes is open (`activeFolder` is ALL_INBOXES) the drawer lists All Inboxes, then one
// collapsible section per shown account (`accounts`, drawer/AccountSection.jsx): avatar, address,
// unread count and the account's own folder tree, read when the section opens, the open ones
// remembered. A tap on one of those folders opens that account's folder (`onSelectIn`). (Desktop's
// UnifiedFolderList reads desktop's account store, so it is not reused.) There is one Drafts: when
// the account has a Drafts folder (`draftsFolder`, folders.js) that folder's row counts the phone's
// local drafts (the folder lists them on top, App.jsx) and carries `data-mv-drafts`; otherwise, and
// in All Inboxes, a Drafts row below the folders (the local drafts, with their count) opens the
// drafts list. Follow up
// (shown while there are follow-up reminders, with the count that found no reply) opens the
// reminders list; in All Inboxes both are every shown account's. The footer's Settings opens the
// settings screen.
// Desktop's saved views (`views`, with their counts) follow the folders, under desktop's Views
// heading and each with desktop's icon, as on desktop's sidebar: a tap opens the view's mail
// (ViewResults.jsx). The heading carries desktop's Edit and New (`onEditViews`, `onNewView`: Settings
// > Views, the second on a new view), shown with no view as on desktop.
// Drafts, Follow up and Settings wear the glyphs desktop's sidebar gives them.
import React, { useCallback, useState } from 'react';
import { Bell, File, Pencil, Plus, Settings } from 'lucide-react';
import Sheet from './Sheet.jsx';
import { useT } from './i18n.js';
import { draftsFolder, ALL_INBOXES } from './folders.js';
import { Avatar, hasIssue } from './AccountSwitcher.jsx';
import { AllInboxesIcon, ChevronDownIcon } from './icons.jsx';
import { ViewIcon } from '../components/ViewIcon.jsx';
import { viewLabel } from '../utils/viewLabel.js';
import { Button } from '../components/ui/Button.jsx';
import AccountSection from './drawer/AccountSection.jsx';
import FolderColorSheet from './drawer/FolderColorSheet.jsx';
import FolderList from './drawer/FolderList.jsx';
import { readExpanded, writeExpanded } from './drawer/expanded.js';

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
        <Avatar account={account} small issue={hasIssue(account)} />
      )}
      <span className="mv-header__email" dir="auto">{allInboxes ? t('sidebar.allInboxes') : name}</span>
      <ChevronDownIcon className="mv-header__chevron" />
    </Button>
  );
}

export default function FolderDrawer({ account, accounts = [], folders, activeFolder, onSelect, onSelectIn, onClose, onSwitchAccount, drafts = 0, onDrafts, followUps = 0, followUpsDue = 0, onFollowUps, onSettings, views = [], viewCounts = {}, onView, onEditViews, onNewView }) {
  const t = useT();
  const allInboxes = activeFolder === ALL_INBOXES;
  // The account's Drafts folder is the one Drafts: the local drafts are counted on it.
  const draftsPath = allInboxes ? null : draftsFolder(folders)?.path ?? null;
  // The account sections that are open (kept between launches), and the folder being coloured.
  const [open, setOpen] = useState(readExpanded);
  const [coloring, setColoring] = useState(null); // { folder, accountId }
  const toggle = useCallback((id) => {
    setOpen((ids) => {
      const next = ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
      writeExpanded(next);
      return next;
    });
  }, []);
  const colour = useCallback((folder, accountId) => setColoring({ folder, accountId }), []);
  return (
    <>
      <Sheet kind="drawer" label={t('mobile.drawer.title')} onClose={onClose}>
        <div className="mv-drawer__head">
          <DrawerHead account={account} allInboxes={allInboxes} onSwitchAccount={onSwitchAccount} />
        </div>
        {allInboxes ? (
          <>
            <ul className="mv-folders">
              <li>
                <button type="button" className="mv-folder mv-folder--active" aria-current="true" data-mv-drawer-all-inboxes onClick={onClose}>
                  <span className="mv-folder__icon"><AllInboxesIcon size={16} /></span>
                  <span className="mv-folder__name">{t('sidebar.allInboxes')}</span>
                </button>
              </li>
            </ul>
            {accounts.map((a) => (
              <AccountSection key={a.id} account={a} expanded={open.includes(a.id)} onToggle={toggle} onSelectIn={onSelectIn} onHold={colour} />
            ))}
          </>
        ) : folders.length === 0 ? (
          <p className="mv-drawer__empty">{t('mobile.drawer.empty')}</p>
        ) : (
          <FolderList folders={folders} accountId={account?.id} activeFolder={activeFolder} draftsPath={draftsPath} drafts={drafts} onSelect={onSelect} onHold={(folder) => colour(folder, account?.id)} />
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
      {coloring && <FolderColorSheet folder={coloring.folder} accountId={coloring.accountId} onClose={() => setColoring(null)} />}
    </>
  );
}
