// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

vi.mock('../../../i18n', () => ({ useT: () => (k) => k }));
vi.mock('lucide-react', () => new Proxy({}, {
  get: (_t, name) => (typeof name === 'symbol' || name === 'then' ? undefined : () => null),
  has: () => true,
}));
const h = vi.hoisted(() => ({ exportContacts: vi.fn() }));
vi.mock('../../../services/contactsExport', () => h);

import { ExportButton } from '../ExportButton';

beforeEach(() => h.exportContacts.mockReset());
afterEach(cleanup);

describe('ExportButton', () => {
  it('click runs the export', async () => {
    h.exportContacts.mockResolvedValue({ ok: true });
    render(<ExportButton />);
    fireEvent.click(screen.getByTestId('contacts-export'));
    await waitFor(() => expect(h.exportContacts).toHaveBeenCalledTimes(1));
    expect(h.exportContacts).toHaveBeenCalledWith('contacts.export');
    expect(screen.queryByTestId('contacts-export-error')).toBeNull();
  });

  it('a failure shows the failure text', async () => {
    h.exportContacts.mockResolvedValue({ ok: false, errorKey: 'contacts.exportFailed' });
    render(<ExportButton />);
    fireEvent.click(screen.getByTestId('contacts-export'));
    expect((await screen.findByTestId('contacts-export-error')).textContent).toBe('contacts.exportFailed');
  });

  it('a cancelled pick shows nothing', async () => {
    h.exportContacts.mockResolvedValue({ ok: false, cancelled: true });
    render(<ExportButton />);
    fireEvent.click(screen.getByTestId('contacts-export'));
    await waitFor(() => expect(h.exportContacts).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId('contacts-export').disabled).toBe(false));
    expect(screen.queryByTestId('contacts-export-error')).toBeNull();
  });

  it('a retry after a failure clears the old message', async () => {
    h.exportContacts.mockResolvedValueOnce({ ok: false, errorKey: 'contacts.exportFailed' }).mockResolvedValueOnce({ ok: true });
    render(<ExportButton />);
    fireEvent.click(screen.getByTestId('contacts-export'));
    await screen.findByTestId('contacts-export-error');
    fireEvent.click(screen.getByTestId('contacts-export'));
    await waitFor(() => expect(screen.queryByTestId('contacts-export-error')).toBeNull());
  });
});
