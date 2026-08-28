// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

const buildExport = vi.fn();
const saveOneFile = vi.fn(async () => '/tmp/out.png');
const saveFilesToDirectory = vi.fn(async () => ({ dir: '/tmp', written: 2 }));
vi.mock('../../../services/export/exportService', () => ({
  buildExport: (...a) => buildExport(...a),
  SAMPLE: Symbol('sample'),
}));
vi.mock('../../../services/export/exportSaver', () => ({
  saveOneFile: (...a) => saveOneFile(...a),
  saveFilesToDirectory: (...a) => saveFilesToDirectory(...a),
}));

const hasPremiumAccess = vi.fn(() => true);
vi.mock('../../../stores/settingsStore', () => ({
  hasPremiumAccess: (...a) => hasPremiumAccess(...a),
  useSettingsStore: (sel) => sel({ billingProfile: { hasSubscription: true } }),
}));

import { ExportDialog } from '../ExportDialog';

// The format radios are queried anchored (/^image$/) because the layout row
// also says "image" — "One tall image" and "Separate images" both match a bare
// /image/, and getByRole throws on three hits. Each input carries an explicit
// aria-label so the anchored name is exactly the choice.

const messages = [
  { uid: 1, from: 'Ana Brandt <ana@sizzlemedia.co>', date: new Date('2026-08-12T09:14:00'), subject: 'Root', html: '<p>a</p>' },
  { uid: 2, from: 'Theo Lomas <theo@skewer.systems>', date: new Date('2026-08-20T09:14:00'), subject: 'Re: Root', html: '<p>b</p>' },
];
const props = { open: true, account: 'r@x.test', mailbox: 'INBOX', onClose: () => {}, onUpgrade: () => {}, onShowSamples: () => {} };

beforeEach(() => {
  hasPremiumAccess.mockReturnValue(true);
  buildExport.mockReset();
  buildExport.mockResolvedValue({ ok: true, files: [{ name: 'out.png', base64: 'A' }], failures: [], stats: {} });
  saveOneFile.mockClear(); saveFilesToDirectory.mockClear();
});
afterEach(cleanup);

describe('ExportDialog', () => {
  it('offers both formats', () => {
    render(<ExportDialog {...props} messages={messages} />);
    expect(screen.getByRole('radio', { name: /^image$/i })).toBeTruthy();
    expect(screen.getByRole('radio', { name: /^html$/i })).toBeTruthy();
  });

  it('offers a layout choice only for an image export of a thread', () => {
    render(<ExportDialog {...props} messages={messages} />);
    expect(screen.getByRole('radio', { name: /one tall image/i })).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: /^html$/i }));
    expect(screen.queryByRole('radio', { name: /one tall image/i })).toBeNull();
  });

  it('hides the layout choice for a single message', () => {
    render(<ExportDialog {...props} messages={[messages[0]]} />);
    expect(screen.queryByRole('radio', { name: /one tall image/i })).toBeNull();
  });

  it('has the mirror toggle on by default and says what it does', () => {
    render(<ExportDialog {...props} messages={messages} />);
    const toggle = screen.getByRole('checkbox', { name: /mirror remote content/i });
    expect(toggle.checked).toBe(true);
    expect(screen.getByText(/senders' servers/i)).toBeTruthy();
  });

  it('passes the chosen options through to the builder', async () => {
    render(<ExportDialog {...props} messages={messages} />);
    fireEvent.click(screen.getByRole('radio', { name: /separate images/i }));
    fireEvent.click(screen.getByRole('checkbox', { name: /mirror remote content/i }));
    fireEvent.click(screen.getByRole('button', { name: /^export$/i }));
    await waitFor(() => expect(buildExport).toHaveBeenCalled());
    expect(buildExport.mock.calls[0][0]).toMatchObject({ format: 'image', layout: 'separate', mirror: false });
  });

  it('saves one file through the save dialog', async () => {
    render(<ExportDialog {...props} messages={[messages[0]]} />);
    fireEvent.click(screen.getByRole('button', { name: /^export$/i }));
    await waitFor(() => expect(saveOneFile).toHaveBeenCalled());
    expect(saveFilesToDirectory).not.toHaveBeenCalled();
  });

  it('saves many files through the directory picker', async () => {
    buildExport.mockResolvedValue({
      ok: true, files: [{ name: 'a.png', base64: 'A' }, { name: 'b.png', base64: 'B' }], failures: [], stats: {},
    });
    render(<ExportDialog {...props} messages={messages} />);
    fireEvent.click(screen.getByRole('radio', { name: /separate images/i }));
    fireEvent.click(screen.getByRole('button', { name: /^export$/i }));
    await waitFor(() => expect(saveFilesToDirectory).toHaveBeenCalled());
  });

  it('shows the upsell instead of the controls for a free user', () => {
    hasPremiumAccess.mockReturnValue(false);
    render(<ExportDialog {...props} messages={messages} />);
    expect(screen.queryByRole('button', { name: /^export$/i })).toBeNull();
    expect(screen.getByRole('button', { name: /see samples/i })).toBeTruthy();
  });

  it('reports a partial export instead of claiming success', async () => {
    buildExport.mockResolvedValue({
      ok: true, partial: true, files: [{ name: 'a.png', base64: 'A' }],
      failures: [{ uid: 2, subject: 'Re: Root', error: 'rasterize failed' }], stats: {},
    });
    render(<ExportDialog {...props} messages={messages} />);
    fireEvent.click(screen.getByRole('button', { name: /^export$/i }));
    await screen.findByText(/1 message could not be exported/i);
  });

  it('surfaces an outright failure', async () => {
    buildExport.mockResolvedValue({ ok: false, reason: 'render', files: [], failures: [] });
    render(<ExportDialog {...props} messages={messages} />);
    fireEvent.click(screen.getByRole('button', { name: /^export$/i }));
    await screen.findByText(/could not be exported/i);
    expect(saveOneFile).not.toHaveBeenCalled();
  });
});

// One dialog instance serves all four entry points, so its state survives a
// close. Anything that describes the LAST export must not greet the next one.
describe('reopening the dialog', () => {
  it('does not show the previous failure', async () => {
    buildExport.mockResolvedValue({ ok: false, reason: 'render', files: [], failures: [] });
    const { rerender } = render(<ExportDialog {...props} messages={messages} />);
    fireEvent.click(screen.getByRole('button', { name: /^export$/i }));
    await screen.findByText(/could not be exported/i);

    rerender(<ExportDialog {...props} open={false} messages={messages} />);
    rerender(<ExportDialog {...props} open messages={messages} />);

    expect(screen.queryByText(/could not be exported/i)).toBeNull();
    expect(screen.getByRole('button', { name: /^export$/i })).toBeTruthy();
  });
});
