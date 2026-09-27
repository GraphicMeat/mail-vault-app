import React, { useEffect, useRef } from 'react';
import TomSelect from 'tom-select';
import 'tom-select/dist/css/tom-select.css';

/** Tom Select's searchable single choice, with React retaining the value. */
export function TomSelectField({ label, value, options, placeholder, onChange, create = false }) {
  const element = useRef(null);
  const instance = useRef(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  // One selection reaches us twice in the same tick: Tom Select's onChange
  // setting and the change event it fires on the select below (React's
  // onChange). Report a value only when it differs from the last one we
  // reported or were given, so every consumer sees one change per selection.
  const lastValue = useRef(String(value ?? ''));
  const emit = next => {
    const normalized = String(next ?? '');
    if (normalized === lastValue.current) return;
    lastValue.current = normalized;
    onChangeRef.current?.(next);
  };

  useEffect(() => {
    if (!element.current) return undefined;
    const select = new TomSelect(element.current, {
      create,
      maxItems: 1,
      allowEmptyOption: true,
      placeholder,
      onChange: next => emit(next),
    });
    instance.current = select;
    select.control_input.setAttribute('aria-label', label);
    return () => { instance.current = null; select.destroy(); };
  }, []);

  useEffect(() => {
    lastValue.current = String(value ?? '');
    const select = instance.current;
    if (!select) return;
    select.clearOptions();
    options.forEach(option => select.addOption({ value: String(option.value), text: option.label }));
    if (value && !options.some(option => String(option.value) === String(value))) {
      select.addOption({ value: String(value), text: String(value) });
    }
    select.refreshOptions(false);
    select.setValue(value || '', true);
  }, [options, value]);

  useEffect(() => {
    if (!instance.current) return;
    instance.current.control_input.setAttribute('aria-label', label);
    instance.current.control_input.placeholder = placeholder || '';
  }, [label, placeholder]);

  const hasEmptyOption = options.some(option => String(option.value) === '');
  return <select ref={element} aria-label={label} value={value || ''} onChange={event => emit(event.target.value)}>
    {!hasEmptyOption && <option value="">{placeholder}</option>}
    {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
  </select>;
}
