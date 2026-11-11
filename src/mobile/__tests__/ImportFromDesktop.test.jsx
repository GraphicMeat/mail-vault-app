// @vitest-environment jsdom
// "Import from computer": instructions, the camera loop, the password, the result. The camera is
// the scanner seam (mocked); the import is the caller's `onImport` (the store's engine call).
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react';
import ImportFromDesktop from '../ImportFromDesktop.jsx';
import { cameraAccess, scanQr, cancelScan, openCameraSettings } from '../scanner.js';
import { t } from '../i18n.js';

vi.mock('../scanner.js', () => ({
  cameraAccess: vi.fn(),
  scanQr: vi.fn(),
  cancelScan: vi.fn(async () => {}),
  openCameraSettings: vi.fn(async () => {}),
}));

const frame = (id, i, n) => `MVQR1:${id}:${i}/${n}:QUJD${i}`;
const PW = 'twelve-chars-pw';

/** `scanQr` answers from a queue the test fills; an empty queue waits for the next push. */
function cameraQueue() {
  const queue = [];
  const waiting = [];
  scanQr.mockImplementation(() => new Promise((resolve, reject) => {
    if (queue.length) {
      const next = queue.shift();
      if (next instanceof Error) reject(next); else resolve(next);
    } else waiting.push({ resolve, reject });
  }));
  cancelScan.mockImplementation(async () => {
    for (const w of waiting.splice(0)) w.reject(Object.assign(new Error('cancelled'), { code: 'CANCELLED' }));
  });
  return {
    async show(...texts) {
      for (const text of texts) {
        await act(async () => {
          const w = waiting.shift();
          if (!w) queue.push(text);
          else if (text instanceof Error) w.reject(text);
          else w.resolve(text);
        });
      }
    },
  };
}

beforeEach(() => {
  cameraAccess.mockResolvedValue('granted');
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  document.documentElement.classList.remove('mv-import-scanning');
});

const button = (key) => screen.getByRole('button', { name: t(key) });

async function scanAll(camera, frames) {
  await act(async () => { fireEvent.click(button('mobile.import.scan')); });
  await camera.show(...frames);
  await screen.findByLabelText(t('mobile.import.password'));
}

describe('ImportFromDesktop', () => {
  it('explains the three steps on the computer, with pictures and the FAQ entry', () => {
    render(<ImportFromDesktop onImport={vi.fn()} onDone={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByRole('heading', { name: t('mobile.import.title') })).toBeTruthy();
    const steps = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(steps).toEqual([t('mobile.import.step1'), t('mobile.import.step2'), t('mobile.import.step3')]);
    expect(screen.getByRole('img', { name: t('mobile.import.shotSettings') }).getAttribute('src')).toMatch(/desktop-settings/);
    expect(screen.getByRole('img', { name: t('mobile.import.shotQr') }).getAttribute('src')).toMatch(/desktop-qr/);
    const faq = screen.getByRole('link', { name: t('mobile.import.faq') });
    expect(faq.getAttribute('href')).toBe('https://mailvaultapp.com/faq.html?utm_source=app&utm_medium=mobile_import#phone-import');
    expect(faq.getAttribute('target')).toBe('_blank');
    expect(button('mobile.import.scan')).toBeTruthy();
  });

  it('scans every part, showing which part it has, then asks for the password', async () => {
    const camera = cameraQueue();
    render(<ImportFromDesktop onImport={vi.fn()} onDone={vi.fn()} onCancel={vi.fn()} />);
    await act(async () => { fireEvent.click(button('mobile.import.scan')); });
    expect(cameraAccess).toHaveBeenCalledTimes(1);
    expect(screen.getByText(t('mobile.import.scanning'))).toBeTruthy();
    // The camera shows behind the page while it scans.
    expect(document.documentElement.classList.contains('mv-import-scanning')).toBe(true);

    await camera.show(frame('aaaaaaaa', 2, 3));
    expect(screen.getByRole('status').textContent).toContain(t('mobile.import.progress', { have: 1, total: 3 }));
    await camera.show(frame('aaaaaaaa', 2, 3), 'https://not-ours.example');
    expect(screen.getByText(t('mobile.import.notOurs'))).toBeTruthy();
    await camera.show(frame('aaaaaaaa', 1, 3));
    expect(screen.getByRole('status').textContent).toContain(t('mobile.import.progress', { have: 2, total: 3 }));
    await camera.show(frame('aaaaaaaa', 3, 3));

    expect(await screen.findByLabelText(t('mobile.import.password'))).toBeTruthy();
    expect(document.documentElement.classList.contains('mv-import-scanning')).toBe(false);
    expect(scanQr).toHaveBeenCalledTimes(5);
  });

  it('starts over when the computer shows a new code', async () => {
    const camera = cameraQueue();
    const onImport = vi.fn(async () => ({ ok: true, imported: [], existing: [], skipped: [] }));
    render(<ImportFromDesktop onImport={onImport} onDone={vi.fn()} onCancel={vi.fn()} />);
    await act(async () => { fireEvent.click(button('mobile.import.scan')); });
    await camera.show(frame('aaaaaaaa', 1, 2), frame('bbbbbbbb', 1, 2));
    expect(screen.getByRole('status').textContent).toContain(t('mobile.import.progress', { have: 1, total: 2 }));
    await camera.show(frame('bbbbbbbb', 2, 2));
    fireEvent.change(await screen.findByLabelText(t('mobile.import.password')), { target: { value: PW } });
    await act(async () => { fireEvent.click(button('mobile.import.import')); });
    expect(onImport).toHaveBeenCalledWith({ frames: [frame('bbbbbbbb', 1, 2), frame('bbbbbbbb', 2, 2)], password: PW });
  });

  it('Cancel stops the camera and goes back to the steps', async () => {
    cameraQueue();
    render(<ImportFromDesktop onImport={vi.fn()} onDone={vi.fn()} onCancel={vi.fn()} />);
    await act(async () => { fireEvent.click(button('mobile.import.scan')); });
    await act(async () => { fireEvent.click(button('common.cancel')); });
    expect(cancelScan).toHaveBeenCalled();
    expect(button('mobile.import.scan')).toBeTruthy();
    expect(document.documentElement.classList.contains('mv-import-scanning')).toBe(false);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('stops the camera when it goes away mid-scan', async () => {
    cameraQueue();
    const { unmount } = render(<ImportFromDesktop onImport={vi.fn()} onDone={vi.fn()} onCancel={vi.fn()} />);
    await act(async () => { fireEvent.click(button('mobile.import.scan')); });
    unmount();
    expect(cancelScan).toHaveBeenCalled();
    expect(document.documentElement.classList.contains('mv-import-scanning')).toBe(false);
  });

  it('says so when the camera is not allowed, and offers the settings', async () => {
    cameraAccess.mockResolvedValue('denied');
    render(<ImportFromDesktop onImport={vi.fn()} onDone={vi.fn()} onCancel={vi.fn()} />);
    await act(async () => { fireEvent.click(button('mobile.import.scan')); });
    expect(screen.getByRole('alert').textContent).toBe(t('mobile.import.cameraDenied'));
    expect(scanQr).not.toHaveBeenCalled();
    fireEvent.click(button('mobile.import.openSettings'));
    expect(openCameraSettings).toHaveBeenCalledTimes(1);
  });

  it('a camera refused mid-scan reads as denied, any other failure as failed', async () => {
    const camera = cameraQueue();
    render(<ImportFromDesktop onImport={vi.fn()} onDone={vi.fn()} onCancel={vi.fn()} />);
    await act(async () => { fireEvent.click(button('mobile.import.scan')); });
    await camera.show(Object.assign(new Error('x'), { code: 'CAMERA_DENIED' }));
    expect(screen.getByRole('alert').textContent).toBe(t('mobile.import.cameraDenied'));
    await act(async () => { fireEvent.click(button('mobile.import.scanAgain')); });
    await camera.show(Object.assign(new Error('x'), { code: 'SCAN_FAILED' }));
    expect(screen.getByRole('alert').textContent).toBe(t('mobile.import.scanFailed'));
  });

  it('asks for at least 12 characters and can show the password', async () => {
    const camera = cameraQueue();
    render(<ImportFromDesktop onImport={vi.fn()} onDone={vi.fn()} onCancel={vi.fn()} />);
    await scanAll(camera, [frame('aaaaaaaa', 1, 1)]);
    const input = screen.getByLabelText(t('mobile.import.password'));
    expect(input.getAttribute('type')).toBe('password');
    fireEvent.change(input, { target: { value: 'eleven-char' } });
    expect(button('mobile.import.import').disabled).toBe(true);
    // Characters, as the desktop counts them: 11 emoji are 22 UTF-16 units but 11 characters.
    fireEvent.change(input, { target: { value: '\u{1F600}'.repeat(11) } });
    expect(button('mobile.import.import').disabled).toBe(true);
    fireEvent.change(input, { target: { value: PW } });
    expect(button('mobile.import.import').disabled).toBe(false);
    fireEvent.click(button('mobile.import.show'));
    expect(input.getAttribute('type')).toBe('text');
    fireEvent.click(button('mobile.import.hide'));
    expect(input.getAttribute('type')).toBe('password');
  });

  it('a wrong password clears the field and asks again', async () => {
    const camera = cameraQueue();
    const onImport = vi.fn(async () => ({ ok: false, code: 'BAD_PASSWORD' }));
    render(<ImportFromDesktop onImport={onImport} onDone={vi.fn()} onCancel={vi.fn()} />);
    await scanAll(camera, [frame('aaaaaaaa', 1, 1)]);
    fireEvent.change(screen.getByLabelText(t('mobile.import.password')), { target: { value: PW } });
    await act(async () => { fireEvent.click(button('mobile.import.import')); });
    expect(screen.getByRole('alert').textContent).toBe(t('mobile.import.badPassword'));
    expect(screen.getByLabelText(t('mobile.import.password')).value).toBe('');
  });

  it('a damaged code offers to scan again', async () => {
    const camera = cameraQueue();
    const onImport = vi.fn(async () => ({ ok: false, code: 'INVALID' }));
    render(<ImportFromDesktop onImport={onImport} onDone={vi.fn()} onCancel={vi.fn()} />);
    await scanAll(camera, [frame('aaaaaaaa', 1, 1)]);
    fireEvent.change(screen.getByLabelText(t('mobile.import.password')), { target: { value: PW } });
    await act(async () => { fireEvent.click(button('mobile.import.import')); });
    expect(screen.getByRole('alert').textContent).toBe(t('mobile.import.invalid'));
    await act(async () => { fireEvent.click(button('mobile.import.scanAgain')); });
    expect(scanQr).toHaveBeenCalledTimes(2);
    expect(screen.getByText(t('mobile.import.scanning'))).toBeTruthy();
  });

  it('lists what was added, what was already here and what was left out, then Done', async () => {
    const camera = cameraQueue();
    const onDone = vi.fn();
    const onImport = vi.fn(async () => ({
      ok: true,
      imported: ['ann@example.test'],
      existing: ['bob@example.test'],
      skipped: [{ email: 'cy@example.test', reason: 'invalid' }, { email: 'di@example.test', reason: 'something-new' }],
    }));
    render(<ImportFromDesktop onImport={onImport} onDone={onDone} onCancel={vi.fn()} />);
    await scanAll(camera, [frame('aaaaaaaa', 1, 1)]);
    fireEvent.change(screen.getByLabelText(t('mobile.import.password')), { target: { value: PW } });
    await act(async () => { fireEvent.click(button('mobile.import.import')); });
    await waitFor(() => expect(screen.getByRole('heading', { name: t('mobile.import.resultTitle') })).toBeTruthy());
    const section = (key) => screen.getByRole('list', { name: t(key) });
    expect(section('mobile.import.imported').textContent).toContain('ann@example.test');
    expect(section('mobile.import.existing').textContent).toContain('bob@example.test');
    const skipped = section('mobile.import.skipped').textContent;
    expect(skipped).toContain('cy@example.test');
    expect(skipped).toContain(t('mobile.import.reason.invalid'));
    expect(skipped).toContain(t('mobile.import.reason.other'));
    fireEvent.click(button('common.done'));
    expect(onDone).toHaveBeenCalledWith({ imported: ['ann@example.test'] });
  });

  it('Back from the steps is the caller\'s cancel', () => {
    const onCancel = vi.fn();
    render(<ImportFromDesktop onImport={vi.fn()} onDone={vi.fn()} onCancel={onCancel} />);
    fireEvent.click(button('common.back'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
