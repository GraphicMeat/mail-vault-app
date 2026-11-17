import React from 'react';
import { Private } from '../privacy/Private';
import { usePrivateAttr } from '../../hooks/usePrivacy';

export function AccountSections({ sections, renderAccount, compact = false }) {
  const pa = usePrivateAttr();
  if (compact) return sections.map((section, index) => <React.Fragment key={section.name === null ? 'ungrouped' : `group-${section.name}`}>
    {index > 0 && <div role="separator" className="sidebar-collapsed-divider" title={pa(section.name, 'name')} />}
    {section.accounts.map(renderAccount)}
  </React.Fragment>);
  return sections.map(section => section.name === null
    ? <React.Fragment key="ungrouped">{section.accounts.map(renderAccount)}</React.Fragment>
    : <div key={`group-${section.name}`} role="group" aria-label={pa(section.name, 'name')}>
      <div className="sidebar-group-label"><Private kind="name">{section.name}</Private></div>
      {section.accounts.map(renderAccount)}
    </div>);
}
