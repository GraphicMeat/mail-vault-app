// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
vi.mock('../../../services/transport', () => ({ send: vi.fn() }));
vi.mock('../../../services/billingApi', () => ({ openInBrowser: vi.fn(async () => {}) }));
import { send } from '../../../services/transport';
import { openInBrowser } from '../../../services/billingApi';
import GpuRow, { GPU_LINKS, hostOs, statusLine, reasonKey } from '../GpuRow';
import SettingsRow from '../SettingsRow';
import { useSettingsStore } from '../../../stores/settingsStore';
import en from '../../../i18n/locales/en.json';

const t = (k, v = {}) => Object.entries(v).reduce((s, [a, b]) => s.replace(`{{${a}}}`, b), en[k] ?? k);
const OK = { compiled: true, wanted: false, active: false, probe: { compiled: true, ok: true, adapter: 'Apple M2', backend: 'Metal' }, broken: null };

beforeEach(() => {
  send.mockReset();
  send.mockResolvedValue(OK);
  openInBrowser.mockClear();
  useSettingsStore.setState({ emailRenderer: 'blitz', blitzGpu: false });
});
afterEach(cleanup);

describe('GpuRow helpers', () => {
  it('reads the OS off the user agent', () => {
    expect(hostOs('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('mac');
    expect(hostOs('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('windows');
    expect(hostOs('Mozilla/5.0 (X11; Linux x86_64)')).toBe('linux');
  });
  it('every link key is in the catalog and macOS needs no link', () => {
    for (const [key, url] of [...GPU_LINKS.windows, ...GPU_LINKS.linux]) {
      expect(en[key], key).toBeTruthy();
      expect(url).toMatch(/^https:\/\//);
    }
    expect(GPU_LINKS.mac).toEqual([]);
    for (const os of ['mac', 'windows', 'linux']) expect(en[`blitz.gpu.needs.${os}`], os).toBeTruthy();
  });
  it('folds probe reasons into a missing driver or a failed one', () => {
    expect(reasonKey('no_adapter')).toBe('blitz.gpu.reason.noDriver');
    expect(reasonKey('no_compute')).toBe('blitz.gpu.reason.noDriver');
    for (const r of ['init_failed', 'paint_failed', 'crashed', 'probe_timeout', 'probe_crashed', undefined]) {
      expect(reasonKey(r), String(r)).toBe('blitz.gpu.reason.failed');
    }
  });
  it('says what the daemon found, what is missing, and when the GPU was given up', () => {
    const line = (s) => t(...statusLine(s));
    expect(line(null)).toBe(en['blitz.gpu.checking']);
    expect(line(OK)).toBe('Graphics card: Apple M2 (Metal)');
    expect(line({ compiled: false })).toBe(en['blitz.gpu.notCompiled']);
    expect(line({ compiled: true, probe: { ok: false, reason: 'no_adapter' } })).toBe(en['blitz.gpu.reason.noDriver']);
    expect(line({ ...OK, wanted: true, broken: { reason: 'crashed' } })).toBe(en['blitz.gpu.broken']);
    expect(line({ error: true })).toBe(en['blitz.gpu.reason.failed']);
  });
});

describe('GpuRow', () => {
  it('shows only while the Rust renderer is on', () => {
    useSettingsStore.setState({ emailRenderer: 'web' });
    render(<SettingsRow />);
    expect(screen.queryByTestId('setting-blitz-gpu-group')).toBeNull();
    fireEvent.click(screen.getByRole('switch', { name: en['blitz.settings.title'] }));
    expect(screen.getByTestId('setting-blitz-gpu-group')).toBeTruthy();
  });
  it('probes on mount, flips the setting, and re-probes on Check again', async () => {
    render(<GpuRow />);
    await waitFor(() => expect(screen.getByTestId('blitz-gpu-status').textContent).toBe('Graphics card: Apple M2 (Metal)'));
    expect(send).toHaveBeenCalledWith('render.gpuStatus', { refresh: false });
    fireEvent.click(screen.getByRole('switch', { name: en['blitz.gpu.title'] }));
    expect(useSettingsStore.getState().blitzGpu).toBe(true);
    await waitFor(() => expect(screen.getByTestId('blitz-gpu-recheck').disabled).toBe(false));
    fireEvent.click(screen.getByTestId('blitz-gpu-recheck'));
    await waitFor(() => expect(send).toHaveBeenLastCalledWith('render.gpuStatus', { refresh: true }));
  });
  it('a build without the GPU backend disables the switch', async () => {
    send.mockResolvedValue({ compiled: false, wanted: false, active: false, probe: null, broken: null });
    render(<GpuRow />);
    await waitFor(() => expect(screen.getByTestId('blitz-gpu-status').textContent).toBe(en['blitz.gpu.notCompiled']));
    expect(screen.getByRole('switch', { name: en['blitz.gpu.title'] }).disabled).toBe(true);
  });
  it('a link opens in the browser', async () => {
    render(<GpuRow />);
    const os = hostOs();
    if (GPU_LINKS[os].length === 0) return; // macOS: Metal, nothing to install
    const [key, url] = GPU_LINKS[os][0];
    fireEvent.click(screen.getByText(en[key]));
    expect(openInBrowser).toHaveBeenCalledWith(url);
  });
});
