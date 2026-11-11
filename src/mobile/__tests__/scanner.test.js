// @vitest-environment jsdom
// The camera seam: the official barcode scanner plugin's commands, called through the global bridge
// like every other shell call, with its rejections as codes.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cameraAccess, scanQr, cancelScan, openCameraSettings } from '../scanner.js';

let invoke;
beforeEach(() => {
  invoke = vi.fn();
  window.__TAURI__ = { core: { invoke } };
});
afterEach(() => {
  delete window.__TAURI__;
});

describe('scanner seam', () => {
  it('asks for the camera only when the system has not answered yet', async () => {
    invoke.mockResolvedValueOnce({ camera: 'granted' });
    await expect(cameraAccess()).resolves.toBe('granted');
    expect(invoke.mock.calls.map((c) => c[0])).toEqual(['plugin:barcode-scanner|check_permissions']);

    invoke.mockReset();
    invoke.mockResolvedValueOnce({ camera: 'prompt' }).mockResolvedValueOnce({ camera: 'granted' });
    await expect(cameraAccess()).resolves.toBe('granted');
    expect(invoke.mock.calls.map((c) => c[0])).toEqual(['plugin:barcode-scanner|check_permissions', 'plugin:barcode-scanner|request_permissions']);

    invoke.mockReset();
    invoke.mockResolvedValueOnce({ camera: 'prompt-with-rationale' }).mockResolvedValueOnce({ camera: 'denied' });
    await expect(cameraAccess()).resolves.toBe('denied');

    invoke.mockReset();
    invoke.mockResolvedValueOnce({ camera: 'denied' });
    await expect(cameraAccess()).resolves.toBe('denied');
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('scans QR codes only, with the camera behind the page', async () => {
    invoke.mockResolvedValueOnce({ format: 'QR_CODE', content: 'MVQR1:aaaaaaaa:1/1:QUJD' });
    await expect(scanQr()).resolves.toBe('MVQR1:aaaaaaaa:1/1:QUJD');
    expect(invoke).toHaveBeenCalledWith('plugin:barcode-scanner|scan', { windowed: true, formats: ['QR_CODE'], cameraDirection: 'back' });
  });

  it('turns rejections into codes', async () => {
    invoke.mockRejectedValueOnce('cancelled');
    await expect(scanQr()).rejects.toMatchObject({ code: 'CANCELLED' });
    invoke.mockRejectedValueOnce('Camera permission denied or not yet requested');
    await expect(scanQr()).rejects.toMatchObject({ code: 'CAMERA_DENIED' });
    invoke.mockRejectedValueOnce('No camera available on this device (e.g., iOS Simulator)');
    await expect(scanQr()).rejects.toMatchObject({ code: 'SCAN_FAILED' });
    invoke.mockResolvedValueOnce({ format: 'QR_CODE' });
    await expect(scanQr()).rejects.toMatchObject({ code: 'SCAN_FAILED' });
  });

  it('cancels and opens the app settings through the plugin', async () => {
    invoke.mockResolvedValue(undefined);
    await cancelScan();
    await openCameraSettings();
    expect(invoke.mock.calls.map((c) => c[0])).toEqual(['plugin:barcode-scanner|cancel', 'plugin:barcode-scanner|open_app_settings']);
    // A cancel with nothing running never throws.
    invoke.mockRejectedValueOnce('no scan');
    await expect(cancelScan()).resolves.toBeUndefined();
  });

  it('says NO_TAURI outside the shell', async () => {
    delete window.__TAURI__;
    await expect(scanQr()).rejects.toMatchObject({ code: 'NO_TAURI' });
  });
});
