import React, { useEffect, useId, useState } from 'react';
import { useSettingsStore } from '../../stores/settingsStore';
import { useT } from '../../i18n/index.js';

export function AccountGroupField({ accountId }) {
  const t = useT();
  const listId = useId();
  const accountGroups = useSettingsStore(state => state.accountGroups);
  const setAccountGroup = useSettingsStore(state => state.setAccountGroup);
  const [name, setName] = useState(accountGroups[accountId] || '');
  useEffect(() => setName(accountGroups[accountId] || ''), [accountId, accountGroups]);
  const commit = () => setAccountGroup(accountId, name);

  return <div>
    <label htmlFor={`account-group-${accountId}`} className="block text-sm font-medium text-mail-text mb-2">
      {t('settings.accounts.group')}
    </label>
    <p className="text-sm text-mail-text-muted mb-2">{t('settings.accounts.groupHint')}</p>
    <input id={`account-group-${accountId}`} type="text" list={listId} maxLength={40}
      value={name} onChange={event => setName(event.target.value)} onBlur={commit}
      onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); commit(); } }}
      placeholder={t('settings.accounts.groupPlaceholder')}
      className="w-full px-4 py-2.5 bg-mail-bg border border-mail-border rounded-lg text-mail-text placeholder-mail-text-muted focus:border-mail-accent transition-all" />
    <datalist id={listId}>{[...new Set(Object.values(accountGroups))].map(group => <option key={group} value={group} />)}</datalist>
  </div>;
}
