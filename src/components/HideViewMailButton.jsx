import React, { useRef, useState } from 'react';
import { EyeOff, ChevronDown, Check, Info } from 'lucide-react';
import { useSettingsStore } from '../stores/settingsStore';
import { useAccountStore } from '../stores/accountStore';
import { useViewStore, viewLabel } from '../stores/viewStore';
import { spansMailboxes } from '../stores/slices/unifiedHelpers';
import { mailboxLabel } from '../utils/imapUtf7';
import { Dialog } from './ui/Dialog';
import { Button } from './ui/Button';
import { SegmentedChoice } from './ui/SegmentedChoice';
import { useT } from '../i18n';

const asArray = ids => (Array.isArray(ids) ? ids : null);

/// "Hide view mail" in the list toolbar. Never picked, it is one button that
/// opens the picker. Once picked it is split for good: the left half turns the
/// hide on and off, the right half reopens the picker. A pick that holds no
/// existing view leaves the left half inactive: there is nothing to hide.
///
/// The picker edits three layers: the all-accounts pick; in one account, that
/// account's own pick, which replaces it in the account's folders; and in one
/// folder, that folder's own pick, which replaces both there. A layer with no
/// pick of its own follows the one above it.
///
/// The daemon's numbers (`loadPickerMembers`) show what each view holds in the
/// scope, keep a view with nothing there from being picked, and sum up which
/// accounts the picks hide mail in. Unknown numbers block nothing.
export function HideViewMailButton() {
  const t = useT();
  const views = useViewStore(s => s.views);
  const hideViewMail = useSettingsStore(s => s.hideViewMail);
  const picked = useSettingsStore(s => s.hideViewMailViews);
  const byAccount = useSettingsStore(s => s.hideViewMailByAccount);
  const byMailbox = useSettingsStore(s => s.hideViewMailByMailbox);
  const displayNames = useSettingsStore(s => s.displayNames);
  const setHideViewMail = useSettingsStore(s => s.setHideViewMail);
  const setPicked = useSettingsStore(s => s.setHideViewMailViews);
  const setAccountPick = useSettingsStore(s => s.setHideViewMailForAccount);
  const setFolderPick = useSettingsStore(s => s.setHideViewMailForMailbox);
  const accounts = useAccountStore(s => s.accounts);
  // The one account on screen (a folder or a folder branch), or null in the
  // unified inbox. The one real folder on screen, or null: a branch spans many.
  const accountId = useAccountStore(s => (s.activeAccountId && !s.unifiedInbox && s.activeMailbox !== 'UNIFIED'
    ? s.activeAccountId : null));
  const folderMailbox = useAccountStore(s => (s.activeMailbox && !spansMailboxes(s) ? s.activeMailbox : null));
  const mailbox = accountId ? folderMailbox : null;
  // { scope: 'all' | 'account' | 'folder', all: Set, acct: Set | null, own: Set | null }.
  const [draft, setDraft] = useState(null);
  const [members, setMembers] = useState(null);
  const asked = useRef(0);

  const accountName = id => {
    const account = (accounts || []).find(a => a.id === id);
    return displayNames?.[id] || account?.name || account?.email || id;
  };
  const accountLabel = accountId ? accountName(accountId) : '';
  const folderLabel = mailbox ? mailboxLabel(mailbox) : '';

  const configured = Array.isArray(picked);
  const accountPicks = Object.values(byAccount || {});
  const folderPicks = Object.values(byMailbox || {}).flatMap(boxes => Object.values(boxes || {}));
  // A deleted view's id stays in a pick but holds nothing.
  const holdsLive = ids => Array.isArray(ids) && views.some(view => ids.includes(view.id));
  const live = holdsLive(picked) || accountPicks.some(holdsLive) || folderPicks.some(holdsLive);
  const on = !!hideViewMail && live;

  const open = () => {
    const acct = accountId && asArray(byAccount?.[accountId]) ? new Set(byAccount[accountId]) : null;
    const own = mailbox && asArray(byMailbox?.[accountId]?.[mailbox]) ? new Set(byMailbox[accountId][mailbox]) : null;
    setDraft({ scope: own ? 'folder' : acct ? 'account' : 'all', all: new Set(configured ? picked : []), acct, own });
    // The last known numbers at once; the fresh ones replace them.
    setMembers(useViewStore.getState().pickerMembers ?? null);
    const ask = ++asked.current;
    // A view made in the Settings window since this one loaded its list must
    // be pickable. A failed ask keeps the list it has.
    useViewStore.getState().loadViews().catch(() => {});
    Promise.resolve(useViewStore.getState().loadPickerMembers?.())
      .then(found => { if (ask === asked.current && found) setMembers(found); }, () => {});
  };
  const close = () => {
    asked.current += 1;
    setDraft(null);
  };

  // The pick that holds in each layer under the draft.
  const accountSet = d => d.acct ?? d.all;
  const shownFor = d => (d.scope === 'folder' ? d.own ?? accountSet(d) : d.scope === 'account' ? accountSet(d) : d.all);
  const shown = draft && shownFor(draft);
  const pickIn = (d, account, box) => {
    if (mailbox && account === accountId && box === mailbox) return d.own ?? accountSet(d);
    const ownBox = asArray(byMailbox?.[account]?.[box]);
    if (ownBox) return new Set(ownBox);
    if (account === accountId) return accountSet(d);
    const ownAccount = asArray(byAccount?.[account]);
    return ownAccount ? new Set(ownAccount) : d.all;
  };

  // What one view holds in a scope, or null while unknown.
  const heldIn = (viewId, scope) => {
    if (!members) return null;
    const perAccount = members[viewId] || {};
    const sum = boxes => Object.values(boxes || {}).reduce((n, uids) => n + (Array.isArray(uids) ? uids.length : 0), 0);
    if (scope === 'folder') return perAccount[accountId]?.[mailbox]?.length ?? 0;
    if (scope === 'account') return sum(perAccount[accountId]);
    return Object.values(perAccount).reduce((n, boxes) => n + sum(boxes), 0);
  };
  const emptyIn = scope => !!members && views.every(view => heldIn(view.id, scope) === 0);
  // A view with nothing in the scope cannot be picked there; one already
  // picked can still be let go.
  const blocked = (viewId, scope) => heldIn(viewId, scope) === 0 && !shown?.has(viewId);

  // Accounts the draft hides mail in, in sidebar order, with how much.
  const summary = (() => {
    if (!draft || !members) return null;
    const boxes = {};
    for (const [viewId, held] of Object.entries(members)) {
      for (const [account, perBox] of Object.entries(held || {})) {
        for (const [box, uids] of Object.entries(perBox || {})) {
          if (!Array.isArray(uids) || !pickIn(draft, account, box).has(viewId)) continue;
          const key = `${account}\u0000${box}`;
          boxes[key] ??= { account, uids: new Set() };
          for (const uid of uids) boxes[key].uids.add(uid);
        }
      }
    }
    const perAccount = {};
    for (const { account, uids } of Object.values(boxes)) perAccount[account] = (perAccount[account] || 0) + uids.size;
    const order = (accounts || []).map(a => a.id);
    const rank = id => (order.includes(id) ? order.indexOf(id) : order.length);
    return Object.keys(perAccount).filter(id => perAccount[id] > 0).sort((a, b) => rank(a) - rank(b))
      .map(id => ({ id, label: accountName(id), count: perAccount[id] }));
  })();

  // Every edit in account or folder scope makes that layer's pick its own.
  const edit = change => setDraft(current => {
    const key = current.scope === 'folder' ? 'own' : current.scope === 'account' ? 'acct' : 'all';
    return { ...current, [key]: change(new Set(shownFor(current))) };
  });
  const flip = id => edit(next => {
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const selectable = draft ? views.filter(view => !blocked(view.id, draft.scope)) : [];
  const everyPicked = !!shown && selectable.length > 0 && selectable.every(view => shown.has(view.id));
  const pickAll = () => edit(() => (everyPicked ? new Set() : new Set(selectable.map(view => view.id))));
  const followDefault = () => setDraft(current => ({ ...current, [current.scope === 'folder' ? 'own' : 'acct']: null }));

  const apply = () => {
    // Saved in the views' order, and only views that still exist.
    const inOrder = set => views.map(view => view.id).filter(id => set.has(id));
    const all = inOrder(draft.all);
    setPicked(all);
    const acct = accountId && draft.acct ? inOrder(draft.acct) : null;
    if (accountId) setAccountPick(accountId, acct);
    const own = mailbox && draft.own ? inOrder(draft.own) : null;
    if (mailbox) setFolderPick(accountId, mailbox, own);
    // Hide on while any layer hides something. Emptying one account's or
    // folder's pick leaves the others hiding.
    const otherAccounts = Object.entries(byAccount || {}).filter(([id]) => id !== accountId).map(([, ids]) => ids);
    const otherFolders = Object.entries(byMailbox || {}).flatMap(([id, boxes]) => Object.entries(boxes || {})
      .filter(([box]) => !(id === accountId && box === mailbox)).map(([, ids]) => ids));
    setHideViewMail(all.length > 0 || (acct?.length ?? 0) > 0 || (own?.length ?? 0) > 0
      || otherAccounts.some(holdsLive) || otherFolders.some(holdsLive));
    close();
  };

  const scope = draft?.scope ?? 'all';
  const hint = scope === 'folder' ? t('list.hideViewMailPickHintFolder', { folder: folderLabel })
    : scope === 'account' ? t('list.hideViewMailPickHintAccount', { account: accountLabel })
      : t('list.hideViewMailPickHint');
  const accountEmpty = !!accountId && emptyIn('account');
  const folderEmpty = !!mailbox && (accountEmpty || emptyIn('folder'));
  const note = accountEmpty ? t('list.hideViewMailNoneIn', { place: accountLabel })
    : folderEmpty ? t('list.hideViewMailNoneIn', { place: folderLabel }) : null;
  const followLabel = scope === 'folder' && (draft?.acct || asArray(byAccount?.[accountId]))
    ? t('list.hideViewMailFollowAccount', { account: accountLabel })
    : t('list.hideViewMailFollowDefault');
  const blockedTitle = scope === 'folder' ? t('list.hideViewMailViewEmptyIn', { place: folderLabel })
    : scope === 'account' ? t('list.hideViewMailViewEmptyIn', { place: accountLabel })
      : t('list.hideViewMailViewEmpty');

  const picker = (
    <Dialog open={draft !== null} onClose={close} portal title={t('list.hideViewMailPickTitle')}
      description={hint} data-testid="hide-view-mail-modal"
      footer={<>
        <Button variant="secondary" onClick={close}>{t('common.cancel')}</Button>
        <Button variant="primary" data-testid="hide-view-mail-ok" onClick={apply}>{t('list.hideViewMailOk')}</Button>
      </>}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {accountId && (
          <SegmentedChoice label={t('list.hideViewMailScope')} value={scope}
            onChange={next => setDraft(current => ({ ...current, scope: next }))}
            options={[
              { value: 'all', label: t('list.hideViewMailScopeAll') },
              { value: 'account', label: accountLabel, disabled: accountEmpty && scope !== 'account' },
              ...(mailbox ? [{
                value: 'folder', label: t('list.hideViewMailScopeFolder', { folder: folderLabel }),
                disabled: folderEmpty && scope !== 'folder',
              }] : []),
            ]} />
        )}
        <div className="ml-auto flex items-center gap-1">
          {((scope === 'folder' && draft?.own) || (scope === 'account' && draft?.acct)) && (
            <Button size="sm" variant="ghost" data-testid="hide-view-mail-follow-default" onClick={followDefault}>
              {followLabel}
            </Button>
          )}
          <Button size="sm" variant="ghost" data-testid="hide-view-mail-all" disabled={!selectable.length} onClick={pickAll}>
            {everyPicked ? t('list.hideViewMailClearAll') : t('list.hideViewMailSelectAll')}
          </Button>
        </div>
      </div>
      {note && <p className="mb-2 text-xs text-mail-text-muted" data-testid="hide-view-mail-scope-note">{note}</p>}
      <div className="flex flex-wrap gap-2" role="group" aria-label={t('list.hideViewMailPickTitle')}>
        {views.map(view => {
          const chosen = !!shown?.has(view.id);
          const held = heldIn(view.id, scope);
          const off = blocked(view.id, scope);
          return (
            <Button key={view.id} size="sm" pill variant={chosen ? 'accentTint' : 'secondary'}
              data-testid="hide-view-mail-pick" data-view-id={view.id} aria-pressed={chosen}
              disabled={off} title={off ? blockedTitle : undefined}
              onClick={() => flip(view.id)}>
              {chosen && <Check size={14} aria-hidden="true" />}{viewLabel(view, t)}
              {held !== null && (
                <span className="ml-1 tabular-nums opacity-60" data-testid="hide-view-mail-pick-count">{held}</span>
              )}
            </Button>
          );
        })}
      </div>
      {summary && (
        <p className="mt-3 flex items-center gap-1.5 text-xs text-mail-text-muted" data-testid="hide-view-mail-summary"
          title={summary.map(row => `${row.label}: ${row.count}`).join('\n') || undefined}>
          <Info size={13} aria-hidden="true" />
          {summary.length ? t('list.hideViewMailSummary', { count: summary.length }) : t('list.hideViewMailSummaryNone')}
        </p>
      )}
    </Dialog>
  );

  if (!configured) {
    return (
      <>
        <button type="button" data-testid="hide-view-mail-config" className="mail-toolbar-button"
          aria-label={t('list.hideViewMail')} title={t('list.hideViewMailOff')} onClick={open}>
          <EyeOff size={14} />
        </button>
        {picker}
      </>
    );
  }

  return (
    <>
      <div className="mail-split-button" data-testid="hide-view-mail-split" role="group" aria-label={t('list.hideViewMail')}>
        <button type="button" data-testid="hide-view-mail-toggle" className={`mail-toolbar-button ${on ? 'is-active' : ''}`}
          aria-pressed={on} aria-label={t('list.hideViewMail')} disabled={!live}
          title={!live ? t('list.hideViewMailNone') : on ? t('list.hideViewMailOn') : t('list.hideViewMailOff')}
          onClick={() => setHideViewMail(!on)}><EyeOff size={14} /></button>
        <button type="button" data-testid="hide-view-mail-config" className="mail-toolbar-button"
          aria-label={t('list.hideViewMailConfigure')} title={t('list.hideViewMailConfigure')} onClick={open}>
          <ChevronDown size={12} />
        </button>
      </div>
      {picker}
    </>
  );
}
