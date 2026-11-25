// The account picker a settings view gets when its app supplies none (the
// phone, a bare test): a native select over the same rows the desktop's
// EmailSelector draws (components/ui/emailSelectorModel.js). Groups become
// optgroups; an account's aliases follow it, marked with an arrow.
import React from 'react';
import { useViewEnv } from './viewContext';

export function NativeAccountPicker({ value, onChange, sections, leading = [], placeholder = '', ariaLabel, testId, id, disabled = false }) {
  const { privateAttr } = useViewEnv();
  const label = (name, address) => (name
    ? `${privateAttr(name, 'name')} <${privateAttr(address, 'email')}>`
    : privateAttr(address, 'email'));
  const rows = items => items.flatMap(item => [
    <option key={`a:${item.value}`} value={item.value}>{label(item.name, item.address)}</option>,
    ...item.aliases.map(alias => (
      <option key={`l:${alias.value}`} value={alias.value}>{`↳ ${label(alias.name, alias.address)}`}</option>
    )),
  ]);
  return (
    <select id={id} data-testid={testId} aria-label={ariaLabel} value={value ?? ''} disabled={disabled}
      onChange={event => onChange?.(event.target.value)}>
      {placeholder && <option value="">{placeholder}</option>}
      {leading.map(row => <option key={`lead:${row.value}`} value={row.value}>{row.label}</option>)}
      {sections.map(section => (section.name
        ? <optgroup key={`g:${section.name}`} label={privateAttr(section.name, 'name')}>{rows(section.items)}</optgroup>
        : <React.Fragment key="ungrouped">{rows(section.items)}</React.Fragment>))}
    </select>
  );
}
