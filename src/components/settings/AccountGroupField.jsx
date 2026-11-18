import React, { useEffect, useState } from 'react';
import { useSettingsStore } from '../../stores/settingsStore';
import { useMailStore } from '../../stores/mailStore';
import { compareNames } from '../../utils/collation';
import { useT } from '../../i18n/index.js';
import { usePrivacyActive, usePrivateAttr, usePrivateInputClass } from '../../hooks/usePrivacy';
import { groupNames, matchGroups } from '../../services/accountGroups';
import { TypeaheadChips } from '../ui/TypeaheadChips';
import { GroupCloud } from './GroupCloud';

export function AccountGroupField({ accountId }) {
  const t = useT();
  const privacyActive = usePrivacyActive();
  const privateInput = usePrivateInputClass();
  const privateAttr = usePrivateAttr();
  const accountGroups = useSettingsStore(state => state.accountGroups);
  const accounts = useMailStore(state => state.accounts);
  const setAccountGroup = useSettingsStore(state => state.setAccountGroup);
  const [draft, setDraft] = useState('');
  useEffect(() => setDraft(''), [accountId]);
  const current = accountGroups[accountId];
  const groups = groupNames(Object.fromEntries(accounts.map(account => [account.id, accountGroups[account.id]])))
    .sort((a, b) => compareNames(a.name, b.name));
  const { matches, canCreate } = matchGroups(groups, draft);
  const assign = name => { setAccountGroup(accountId, name, accounts.map(account => account.id)); setDraft(''); };
  const clear = () => assign('');
  const options = privacyActive ? [] : [
    ...matches.map(group => ({ value: group.name, label: group.name, detail: String(group.count) })),
    ...(canCreate ? [{ value: draft, label: t('settings.accounts.groupCreate', { name: draft }) }] : []),
  ];

  return <div className="account-group-field">
    <label htmlFor={`account-group-${accountId}`} className="block text-sm font-medium text-mail-text mb-2">
      {t('settings.accounts.group')}
    </label>
    {!privacyActive && <p className="text-sm text-mail-text-muted mb-2">{t('settings.accounts.groupHint')}</p>}
    <TypeaheadChips id={`account-group-${accountId}`} label={t('settings.accounts.group')}
      placeholder={t('settings.accounts.groupPlaceholder')} value={draft.slice(0, 40)}
      onChange={value => setDraft(value.slice(0, 40))}
      chips={current ? [{ key: current, label: privateAttr(current, 'name'), testId: 'account-group-chip' }] : []}
      onRemove={clear} options={options} onPick={option => assign(option.value)}
      onEnterText={assign} onBlur={event => {
        if (draft.trim() && !event.relatedTarget?.matches?.('.view-query-key-remove')) assign(draft);
      }}
      inputClassName={`${privateInput} w-full px-4 py-2.5 bg-mail-bg border border-mail-border rounded-lg text-mail-text placeholder-mail-text-muted focus:border-mail-accent transition-all`} />
    <GroupCloud groups={groups.map(group => ({ ...group, label: privateAttr(group.name, 'name') }))}
      current={current} onPick={assign} onClear={clear} />
  </div>;
}
