// @vitest-environment jsdom
//
// The recipient and subject handlers, moved out of ComposeModal into
// useComposeRecipients. An unchanged value is not an edit (WebKit blurs the
// focused field when sending makes the editor inert), and every real edit
// bumps the field's revision so a late reply preparation never overwrites it.
import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useComposeRecipients } from '../useComposeRecipients';

const setup = (over = {}) => {
  const editRevision = { current: { to: 0, cc: 0, bcc: 0, subject: 0 } };
  const setFormData = vi.fn();
  const setError = vi.fn();
  const params = {
    detaching: false, formData: { to: 'same@x.com', cc: '', bcc: '', subject: '' },
    editRevision, setFormData, setError, ...over,
  };
  const { result } = renderHook(() => useComposeRecipients(params));
  return { result, editRevision, setFormData, setError };
};

describe('useComposeRecipients', () => {
  it('setRecipients ignores a value equal to the field, so a blur is not an edit', () => {
    const { result, editRevision, setFormData, setError } = setup();
    result.current.setRecipients('to')('same@x.com');
    expect(editRevision.current.to).toBe(0);
    expect(setFormData).not.toHaveBeenCalled();
    expect(setError).not.toHaveBeenCalled();
  });

  it('setRecipients bumps the revision, writes the field and clears the error', () => {
    const { result, editRevision, setFormData, setError } = setup();
    result.current.setRecipients('cc')('new@x.com');
    expect(editRevision.current.cc).toBe(1);
    expect(setFormData.mock.calls[0][0]({ to: 'a', cc: '' })).toEqual({ to: 'a', cc: 'new@x.com' });
    expect(setError).toHaveBeenCalledWith(null);
  });

  it('does nothing while the window is handing the draft to another webview', () => {
    const { result, editRevision, setFormData } = setup({ detaching: true });
    result.current.setRecipients('cc')('new@x.com');
    result.current.routeRecipients('bcc', 'b@x.com');
    result.current.moveRecipient('to', 'cc', 'same@x.com');
    result.current.handleChange({ target: { name: 'subject', value: 'Hi' } });
    expect(setFormData).not.toHaveBeenCalled();
    expect(editRevision.current).toEqual({ to: 0, cc: 0, bcc: 0, subject: 0 });
  });

  it('routeRecipients adds the pasted addresses to the field', () => {
    const { result, editRevision, setFormData } = setup();
    result.current.routeRecipients('cc', 'b@x.com');
    expect(editRevision.current.cc).toBe(1);
    const next = setFormData.mock.calls[0][0]({ cc: 'a@x.com' });
    expect(next.cc).toContain('a@x.com');
    expect(next.cc).toContain('b@x.com');
  });

  it('moveRecipient takes the chip from one field and puts it on the other, bumping both', () => {
    const { result, editRevision, setFormData } = setup();
    result.current.moveRecipient('to', 'cc', 'a@x.com');
    expect(editRevision.current.to).toBe(1);
    expect(editRevision.current.cc).toBe(1);
    const next = setFormData.mock.calls[0][0]({ to: 'a@x.com, b@x.com', cc: '' });
    expect(next.to).not.toContain('a@x.com');
    expect(next.to).toContain('b@x.com');
    expect(next.cc).toContain('a@x.com');
  });

  it('handleChange bumps the revision only for fields that have one', () => {
    const { result, editRevision, setFormData } = setup();
    result.current.handleChange({ target: { name: 'subject', value: 'Hi' } });
    expect(editRevision.current.subject).toBe(1);
    result.current.handleChange({ target: { name: 'body', value: '<p>x</p>' } });
    expect('body' in editRevision.current).toBe(false);
    expect(setFormData.mock.calls[1][0]({ subject: 'Hi' })).toEqual({ subject: 'Hi', body: '<p>x</p>' });
  });
});
