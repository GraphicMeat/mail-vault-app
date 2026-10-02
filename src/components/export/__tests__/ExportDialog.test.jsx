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

// The Social panel reads the mail store and the spam folder; neither is under test here.
vi.mock('../../../stores/mailStore', () => ({ useMailStore: { getState: () => ({}) } }));
vi.mock('../../../utils/spamFolder', () => ({ isSpamMessage: () => false }));

const hasPremiumAccess = vi.fn(() => true);
vi.mock('../../../stores/settingsStore', () => ({
  hasPremiumAccess: (...a) => hasPremiumAccess(...a),
  useSettingsStore: (sel) => sel({ billingProfile: { hasSubscription: true } }),
}));

import { ExportDialog } from '../ExportDialog';
import { usePrivacyStore } from '../../../stores/privacyStore';
import { setPrivacyDictionary, getPrivacyDictionary } from '../../../utils/privacy/privacyDictionary';
import { buildNameDictionary } from '../../../utils/privacy/piiDetector';

// The format radios are queried anchored (/^image$/) because the layout row
// also says "image" — "One tall image" and "Separate images" both match a bare
// /image/, and getByRole throws on three hits. Each input carries an explicit
// aria-label so the anchored name is exactly the choice.

const messages = [
  { uid: 1, from: 'Ana Brandt <ana@sizzlemedia.co>', date: new Date('2026-08-12T09:14:00'), subject: 'Root', html: '<p>a</p>' },
  { uid: 2, from: 'Theo Lomas <theo@skewer.systems>', date: new Date('2026-08-20T09:14:00'), subject: 'Re: Root', html: '<p>b</p>' },
];
const props = { open: true, account: 'r@x.test', mailbox: 'INBOX', onClose: () => {}, onUpgrade: () => {}, onShowSamples: () => {} };

// Stands in for PrivacyDictionaryHost: a raised dictWanted gets a fresh build.
let hostDict = buildNameDictionary({ names: [] });
let unHost = null;
beforeEach(() => {
  usePrivacyStore.setState({ enabled: false, dictWanted: false });
  unHost = usePrivacyStore.subscribe((s, prev) => {
    if (s.dictWanted && !prev.dictWanted) setPrivacyDictionary(hostDict, { ready: true });
  });
  hasPremiumAccess.mockReturnValue(true);
  buildExport.mockReset();
  buildExport.mockResolvedValue({ ok: true, files: [{ name: 'out.png', base64: 'A' }], failures: [], stats: {} });
  saveOneFile.mockClear(); saveFilesToDirectory.mockClear();
});
afterEach(() => { cleanup(); unHost?.(); });

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

  it('offers Social for one message only, and says so', () => {
    render(<ExportDialog {...props} messages={messages} />);
    expect(screen.getByRole('radio', { name: /^social$/i }).disabled).toBe(true);
    expect(screen.getByText(/select one message for a social image/i)).toBeTruthy();
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

  it('offers to bring the attachments along, on by default', () => {
    render(<ExportDialog {...props} messages={messages} />);
    const box = screen.getByRole('checkbox', { name: /include attachments/i });
    expect(box.checked).toBe(true);
  });

  it('passes the attachment choice through to the builder', async () => {
    render(<ExportDialog {...props} messages={messages} />);
    fireEvent.click(screen.getByRole('checkbox', { name: /include attachments/i }));
    fireEvent.click(screen.getByRole('button', { name: /^export$/i }));
    await waitFor(() => expect(buildExport).toHaveBeenCalled());
    expect(buildExport.mock.calls[0][0]).toMatchObject({ attachments: false });
  });

  it('hands the attachments to the save dialog beside the one file', async () => {
    const sidecars = [{ stem: 'out', name: 'invoice.pdf', base64: 'P' }];
    buildExport.mockResolvedValue({
      ok: true, files: [{ name: 'out.png', base64: 'A' }], sidecars, failures: [], attachmentFailures: [], stats: {},
    });
    render(<ExportDialog {...props} messages={[messages[0]]} />);
    fireEvent.click(screen.getByRole('button', { name: /^export$/i }));
    await waitFor(() => expect(saveOneFile).toHaveBeenCalled());
    expect(saveOneFile.mock.calls[0][2]).toEqual(sidecars);
  });

  // Into a directory there is no "beside" — the sidecar carries its own full
  // name, or two messages' invoice.pdf land on top of each other.
  it('writes the attachments into the directory under their sidecar names', async () => {
    buildExport.mockResolvedValue({
      ok: true, files: [{ name: 'a.png', base64: 'A' }, { name: 'b.png', base64: 'B' }],
      sidecars: [{ stem: 'a', name: 'invoice.pdf', base64: 'P' }], failures: [], attachmentFailures: [], stats: {},
    });
    render(<ExportDialog {...props} messages={messages} />);
    fireEvent.click(screen.getByRole('radio', { name: /separate images/i }));
    fireEvent.click(screen.getByRole('button', { name: /^export$/i }));
    await waitFor(() => expect(saveFilesToDirectory).toHaveBeenCalled());
    expect(saveFilesToDirectory.mock.calls[0][0].map(f => f.name))
      .toEqual(['a.png', 'b.png', 'a - invoice.pdf']);
  });

  it('names the attachments it could not include, and stays open', async () => {
    const onClose = vi.fn();
    buildExport.mockResolvedValue({
      ok: true, files: [{ name: 'out.png', base64: 'A' }], sidecars: [],
      failures: [], attachmentFailures: ['invoice.pdf'], stats: {},
    });
    render(<ExportDialog {...props} onClose={onClose} messages={[messages[0]]} />);
    fireEvent.click(screen.getByRole('button', { name: /^export$/i }));
    await screen.findByText(/1 attachment could not be included: invoice\.pdf/i);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('reports an attachment the saver could not write', async () => {
    saveOneFile.mockResolvedValueOnce({ path: '/tmp/out.png', failed: ['photo.png'] });
    buildExport.mockResolvedValue({
      ok: true, files: [{ name: 'out.png', base64: 'A' }],
      sidecars: [{ stem: 'out', name: 'photo.png', base64: 'P' }],
      failures: [], attachmentFailures: [], stats: {},
    });
    render(<ExportDialog {...props} messages={[messages[0]]} />);
    fireEvent.click(screen.getByRole('button', { name: /^export$/i }));
    await screen.findByText(/photo\.png/i);
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

  it('redacts on request: blur for an image, the current dictionary, and the flag dropped after', async () => {
    hostDict = buildNameDictionary({ names: ['Ana Brandt'] });
    const wanted = [];
    const un = usePrivacyStore.subscribe(s => wanted.push(s.dictWanted));
    render(<ExportDialog {...props} messages={messages} />);
    expect(screen.queryByRole('radio', { name: /black bar/i })).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: /redact sensitive info/i }));
    expect(screen.getByRole('radio', { name: /^blur$/i }).checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /^export$/i }));
    await waitFor(() => expect(buildExport).toHaveBeenCalled());
    un();
    expect(buildExport.mock.calls[0][0].redact).toEqual({ style: 'blur', dict: getPrivacyDictionary() });
    // Up while the dictionary was fetched, down once it was in hand.
    expect(wanted).toContain(true);
    expect(wanted.at(-1)).toBe(false);
    expect(usePrivacyStore.getState().dictWanted).toBe(false);
  });

  it('always uses bars for a redacted HTML export, and offers no style', async () => {
    render(<ExportDialog {...props} messages={messages} />);
    fireEvent.click(screen.getByRole('checkbox', { name: /redact sensitive info/i }));
    fireEvent.click(screen.getByRole('radio', { name: /^html$/i }));
    expect(screen.queryByRole('radio', { name: /^blur$/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^export$/i }));
    await waitFor(() => expect(buildExport).toHaveBeenCalled());
    expect(buildExport.mock.calls[0][0].redact.style).toBe('bar');
  });

  it('turns attachments off when redaction goes on, and keeps a re-enabled choice', () => {
    render(<ExportDialog {...props} messages={messages} />);
    const attachments = screen.getByRole('checkbox', { name: /include attachments/i });
    expect(attachments.checked).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: /redact sensitive info/i }));
    expect(attachments.checked).toBe(false);
    expect(screen.getByText(/attachment contents are not redacted/i)).toBeTruthy();
    fireEvent.click(attachments);
    expect(attachments.checked).toBe(true);
  });

  it('opens with redaction on (attachments off) while privacy mode is on', async () => {
    usePrivacyStore.setState({ enabled: true });
    render(<ExportDialog {...props} messages={messages} />);
    expect(screen.getByRole('checkbox', { name: /redact sensitive info/i }).checked).toBe(true);
    expect(screen.getByRole('checkbox', { name: /include attachments/i }).checked).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: /^export$/i }));
    await waitFor(() => expect(buildExport).toHaveBeenCalled());
    expect(buildExport.mock.calls[0][0]).toMatchObject({ attachments: false, redact: { style: 'blur' } });
  });

  it('exports unredacted by default', async () => {
    render(<ExportDialog {...props} messages={messages} />);
    fireEvent.click(screen.getByRole('button', { name: /^export$/i }));
    await waitFor(() => expect(buildExport).toHaveBeenCalled());
    expect(buildExport.mock.calls[0][0].redact).toBeNull();
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
