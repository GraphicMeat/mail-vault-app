import React from 'react';
import { useT } from '../../i18n/index.js';

export function GroupCloud({ groups, current, onPick, onClear }) {
  const t = useT();
  if (!groups.length) return null;
  return <div className="account-group-cloud" role="group" aria-label={t('settings.accounts.groupExisting')}>
    <span className="account-group-cloud-label">{t('settings.accounts.groupExisting')}</span>
    <div className="account-group-cloud-pills">
      {groups.map(({ name, label, count }) => {
        const pressed = name.toLocaleLowerCase() === current?.toLocaleLowerCase();
        return <button key={name} type="button" aria-pressed={pressed}
          onMouseDown={event => event.preventDefault()}
          onClick={() => pressed ? onClear() : onPick(name)}>{label} <span>{count}</span></button>;
      })}
    </div>
  </div>;
}
