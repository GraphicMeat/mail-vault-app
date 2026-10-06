// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { ExportFormatTabs } from '../ExportFormatTabs';

afterEach(cleanup);

describe('ExportFormatTabs', () => {
  it('is one group holding Image, HTML and Social, with the current one checked', () => {
    render(<ExportFormatTabs value="html" onChange={() => {}} />);
    const group = screen.getByRole('radiogroup', { name: /export/i });
    const radios = within(group).getAllByRole('radio');
    expect(radios.map(r => r.getAttribute('aria-label'))).toEqual(['Image', 'HTML', 'Social']);
    expect(radios.map(r => r.checked)).toEqual([false, true, false]);
  });

  it('reports the format a tab picks', () => {
    const onChange = vi.fn();
    render(<ExportFormatTabs value="image" onChange={onChange} />);
    fireEvent.click(screen.getByRole('radio', { name: /^social$/i }));
    expect(onChange).toHaveBeenCalledWith('social');
  });

  it('disables Social for a thread and says why, without blocking the others', () => {
    const onChange = vi.fn();
    render(<ExportFormatTabs value="image" onChange={onChange} socialDisabled />);
    const social = screen.getByRole('radio', { name: /^social$/i });
    expect(social.disabled).toBe(true);
    expect(social.closest('label').getAttribute('title')).toMatch(/select one message for a social image/i);
    fireEvent.click(screen.getByRole('radio', { name: /^html$/i }));
    expect(onChange).toHaveBeenCalledWith('html');
  });
});
