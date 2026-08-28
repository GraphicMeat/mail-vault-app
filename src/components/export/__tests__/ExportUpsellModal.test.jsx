// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

const buildExport = vi.fn();
// The symbol is created inside the factory and read back from the mocked
// module: vi.mock is hoisted above every import, so a top-level `const SAMPLE`
// referenced eagerly in the factory body is still in its temporal dead zone.
vi.mock('../../../services/export/exportService', () => ({
  buildExport: (...a) => buildExport(...a),
  SAMPLE: Symbol('sample'),
}));
const saveOneFile = vi.fn(async () => '/tmp/sample.png');
const openInDefaultApp = vi.fn(async () => '/cache/sample.png');
vi.mock('../../../services/export/exportSaver', () => ({
  saveOneFile: (...a) => saveOneFile(...a),
  openInDefaultApp: (...a) => openInDefaultApp(...a),
  saveFilesToDirectory: vi.fn(),
}));

import { SAMPLE } from '../../../services/export/exportService';
import { ExportUpsellModal } from '../ExportUpsellModal';

const pngFile = { name: 'sample.png', base64: 'iVBORw0KGgo=' };
const htmlFile = { name: 'sample.html', base64: btoa('<html></html>') };

beforeEach(() => {
  buildExport.mockReset();
  buildExport.mockImplementation(async ({ format }) => ({
    ok: true, files: [format === 'html' ? htmlFile : pngFile], failures: [], stats: {},
  }));
  saveOneFile.mockClear(); openInDefaultApp.mockClear();
});
afterEach(cleanup);

describe('ExportUpsellModal', () => {
  it('renders the samples through the real pipeline, bypassing the gate', async () => {
    render(<ExportUpsellModal open onClose={() => {}} onUpgrade={() => {}} />);
    await waitFor(() => expect(buildExport).toHaveBeenCalledTimes(3));
    for (const call of buildExport.mock.calls) expect(call[0].gate).toBe(SAMPLE);
  });

  it('shows the two image samples as previews', async () => {
    render(<ExportUpsellModal open onClose={() => {}} onUpgrade={() => {}} />);
    const imgs = await screen.findAllByRole('img', { name: /sample/i });
    expect(imgs.length).toBe(2);
    expect(imgs[0].src).toContain('data:image/png;base64,');
  });

  it('offers open and save for every sample, html included', async () => {
    render(<ExportUpsellModal open onClose={() => {}} onUpgrade={() => {}} />);
    await waitFor(() => expect(screen.getAllByRole('button', { name: /^open$/i }).length).toBe(3));
    expect(screen.getAllByRole('button', { name: /^save/i }).length).toBe(3);
  });

  it('opens a sample in the default app', async () => {
    render(<ExportUpsellModal open onClose={() => {}} onUpgrade={() => {}} />);
    const buttons = await screen.findAllByRole('button', { name: /^open$/i });
    fireEvent.click(buttons[0]);
    await waitFor(() => expect(openInDefaultApp).toHaveBeenCalledWith(pngFile));
  });

  it('saves a sample through the save dialog', async () => {
    render(<ExportUpsellModal open onClose={() => {}} onUpgrade={() => {}} />);
    const buttons = await screen.findAllByRole('button', { name: /^save/i });
    fireEvent.click(buttons[0]);
    await waitFor(() => expect(saveOneFile).toHaveBeenCalled());
  });

  it('falls back to text and still pitches when the renderer throws', async () => {
    // The module caches a successful render for the session, so a fresh module
    // is the only way to reach the failure branch after the tests above have
    // filled that cache. react/@testing-library stay externalised, so this
    // hands back a new ExportUpsellModal against the same React instance.
    vi.resetModules();
    const { ExportUpsellModal: Fresh } = await import('../ExportUpsellModal');
    buildExport.mockRejectedValue(new Error('rasterize failed'));
    render(<Fresh open onClose={() => {}} onUpgrade={() => {}} />);
    await screen.findByText(/previews could not be generated/i);
    expect(screen.getByRole('button', { name: /upgrade/i })).toBeTruthy();
  });
});
