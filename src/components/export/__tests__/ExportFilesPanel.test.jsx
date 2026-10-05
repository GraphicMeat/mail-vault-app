// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

const buildExport = vi.fn();
const saveOneFile = vi.fn(async () => ({ path: '/tmp/out.png', failed: [] }));
const saveFilesToDirectory = vi.fn(async () => ({ dir: '/tmp', written: 2 }));
vi.mock('../../../services/export/exportService', () => ({ buildExport: (...a) => buildExport(...a) }));
vi.mock('../../../services/export/exportSaver', () => ({
  saveOneFile: (...a) => saveOneFile(...a),
  saveFilesToDirectory: (...a) => saveFilesToDirectory(...a),
}));

import { ExportFilesPanel } from '../ExportFilesPanel';
import { useExportOptions } from '../useExportOptions';
import { usePrivacyStore } from '../../../stores/privacyStore';

const stubs = [{ uid: 1, messageId: 'a' }, { uid: 2, messageId: 'b' }];
const ok = { ok: true, files: [{ name: 'out.png', base64: 'A' }], failures: [], stats: {} };

function Harness({ initial, ...rest }) {
  const opts = useExportOptions(initial);
  return <ExportFilesPanel opts={opts} format="image" messages={stubs.slice(0, 1)} account="a@x.test" mailbox="INBOX" {...rest} />;
}

beforeEach(() => {
  usePrivacyStore.setState({ enabled: false });
  buildExport.mockReset();
  saveOneFile.mockClear();
});
afterEach(cleanup);

describe('ExportFilesPanel in a window of its own', () => {
  it('previews and exports through the build it is given, never asking for the dictionary itself', async () => {
    const build = vi.fn(async () => ok);
    const onDone = vi.fn();
    render(<Harness detached build={build} onDone={onDone} />);
    await screen.findByRole('img', { name: 'Preview' });
    expect(build.mock.calls[0][0]).toMatchObject({ format: 'image', attachments: false, redact: null, width: 820, account: 'a@x.test' });
    fireEvent.click(screen.getByRole('checkbox', { name: /redact sensitive info/i }));
    await waitFor(() => expect(build.mock.calls.at(-1)[0].redact).toEqual({ style: 'blur' }));
    fireEvent.click(screen.getByRole('button', { name: /^export$/i }));
    await waitFor(() => expect(saveOneFile).toHaveBeenCalled());
    expect(build.mock.calls.at(-1)[0]).toMatchObject({ attachments: false, redact: { style: 'blur' } });
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(buildExport).not.toHaveBeenCalled();
  });

  it('brings the choices back to the app, and closes with Close', () => {
    const onPopIn = vi.fn();
    const onDone = vi.fn();
    render(<Harness detached build={async () => ok} onPopIn={onPopIn} onDone={onDone} format="html" initial={{ mirror: false }} />);
    fireEvent.click(screen.getByRole('button', { name: /back to app/i }));
    expect(onPopIn).toHaveBeenCalledWith({
      format: 'html', layout: 'single', mirror: false, attachments: true, redact: false, redactStyle: 'blur', width: 820,
    });
    fireEvent.click(screen.getByRole('button', { name: /^close$/i }));
    expect(onDone).toHaveBeenCalled();
  });

  it('offers the layout choice for a thread only', () => {
    const { unmount } = render(<Harness build={async () => ok} />);
    expect(screen.queryByRole('radio', { name: /one tall image/i })).toBeNull();
    unmount();
    render(<Harness build={async () => ok} messages={stubs} />);
    expect(screen.getByRole('radio', { name: /one tall image/i })).toBeTruthy();
  });
});
