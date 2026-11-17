import React from 'react';

export function AccountSections({ sections, renderAccount, compact = false }) {
  if (compact) return sections.map((section, index) => <React.Fragment key={section.name === null ? 'ungrouped' : `group-${section.name}`}>
    {index > 0 && <div role="separator" className="sidebar-collapsed-divider" title={section.name} />}
    {section.accounts.map(renderAccount)}
  </React.Fragment>);
  return sections.map(section => section.name === null
    ? <React.Fragment key="ungrouped">{section.accounts.map(renderAccount)}</React.Fragment>
    : <div key={`group-${section.name}`} role="group" aria-label={section.name}>
      <div className="sidebar-group-label">{section.name}</div>
      {section.accounts.map(renderAccount)}
    </div>);
}
