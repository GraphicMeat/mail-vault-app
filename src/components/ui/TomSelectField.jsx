import React, { useEffect, useRef } from 'react';
import TomSelect from 'tom-select';
import 'tom-select/dist/css/tom-select.css';

/** Tom Select's searchable single choice, with React retaining the value. */
export function TomSelectField({ label, value, options, placeholder, onChange, create = false }) {
  const element = useRef(null);
  const instance = useRef(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!element.current) return undefined;
    const select = new TomSelect(element.current, {
      create,
      maxItems: 1,
      allowEmptyOption: true,
      placeholder,
      onChange: next => onChangeRef.current?.(next),
    });
    instance.current = select;
    select.control_input.setAttribute('aria-label', label);
    return () => { instance.current = null; select.destroy(); };
  }, []);

  useEffect(() => {
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

  return <select ref={element} aria-label={label} value={value || ''} onChange={event => onChange?.(event.target.value)}>
    <option value="">{placeholder}</option>
    {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
  </select>;
}
