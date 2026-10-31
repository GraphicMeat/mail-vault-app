import React, { useCallback, useEffect, useState } from 'react';
import { ExternalLink, RefreshCw } from 'lucide-react';
import { useT } from '../../i18n/index.js';
import { useSettingsStore } from '../../stores/settingsStore';
import { SettingRow } from '../../components/ui/SettingRow';
import { ToggleSwitch } from '../../components/ui/ToggleSwitch';
import { Button } from '../../components/ui/Button';
import { openInBrowser } from '../../services/billingApi';
import { gpuStatusRender } from './service';

// Where a user gets what the graphics-card renderer needs. macOS has Metal built in.
export const GPU_LINKS = {
  windows: [
    ['blitz.gpu.link.windowsDrivers', 'https://support.microsoft.com/en-us/windows/update-drivers-through-device-manager-in-windows-ec62f46c-ff14-c91d-eead-d7126dc1f7b6'],
    ['blitz.gpu.link.nvidia', 'https://www.nvidia.com/en-us/drivers/'],
    ['blitz.gpu.link.amd', 'https://www.amd.com/en/support/download/drivers.html'],
    ['blitz.gpu.link.intel', 'https://www.intel.com/content/www/us/en/support/intel-driver-support-assistant.html'],
  ],
  linux: [
    ['blitz.gpu.link.vulkanLinux', 'https://wiki.archlinux.org/title/Vulkan'],
    ['blitz.gpu.link.ubuntuNvidia', 'https://documentation.ubuntu.com/server/how-to/graphics/install-nvidia-drivers/'],
    ['blitz.gpu.link.nvidia', 'https://www.nvidia.com/en-us/drivers/'],
  ],
  mac: [],
};

export function hostOs(ua = typeof navigator === 'undefined' ? '' : navigator.userAgent) {
  if (/Mac/.test(ua)) return 'mac';
  if (/Windows/.test(ua)) return 'windows';
  return 'linux';
}

// The probe's and the daemon's reasons, folded into the two things a user can act on.
const DRIVER_MISSING = new Set(['no_adapter', 'no_compute']);
export const reasonKey = (reason) => (DRIVER_MISSING.has(reason) ? 'blitz.gpu.reason.noDriver' : 'blitz.gpu.reason.failed');

/** The status line under the toggle, as [catalog key, values], from a `render.gpuStatus` reply. */
export function statusLine(status) {
  if (!status) return ['blitz.gpu.checking'];
  if (status.error) return ['blitz.gpu.reason.failed'];
  if (!status.compiled) return ['blitz.gpu.notCompiled'];
  if (status.wanted && status.broken) return ['blitz.gpu.broken'];
  const p = status.probe || {};
  if (p.ok) return ['blitz.gpu.found', { adapter: p.adapter || '?', backend: p.backend || '?' }];
  return [reasonKey(p.reason)];
}

/** Settings > Appearance, under the Rust renderer: draw its tiles on the graphics card. */
export default function GpuRow() {
  const t = useT();
  const on = useSettingsStore(s => s.blitzGpu === true);
  const setBlitzGpu = useSettingsStore(s => s.setBlitzGpu);
  const [status, setStatus] = useState(null);
  const [checking, setChecking] = useState(false);
  const os = hostOs();

  const check = useCallback(async (refresh) => {
    setChecking(true);
    try { setStatus(await gpuStatusRender(refresh)); } catch { setStatus({ error: true }); } finally { setChecking(false); }
  }, []);
  useEffect(() => { void check(false); }, [check]);

  const usable = status?.compiled !== false;
  return (
    <div data-testid="setting-blitz-gpu-group">
      <SettingRow label={t('blitz.gpu.title')} description={t('blitz.gpu.description')}>
        <ToggleSwitch label={t('blitz.gpu.title')} testId="setting-blitz-gpu" active={on && usable} disabled={!usable} onClick={() => setBlitzGpu(!on)} />
      </SettingRow>
      <div className="mt-1 space-y-2 text-xs leading-relaxed text-mail-text-muted">
        <p data-testid="blitz-gpu-status" role="status">{t(...(checking && status ? ['blitz.gpu.checking'] : statusLine(status)))}</p>
        <p>{t(`blitz.gpu.needs.${os}`)}</p>
        {GPU_LINKS[os].length > 0 && (
          <div className="flex flex-wrap gap-2">
            {GPU_LINKS[os].map(([key, url]) => (
              <Button key={url} variant="subtle" size="sm" data-url={url} onClick={() => openInBrowser(url).catch(() => {})}>
                <ExternalLink size={14} />
                {t(key)}
              </Button>
            ))}
          </div>
        )}
        <Button variant="subtle" size="sm" data-testid="blitz-gpu-recheck" disabled={checking} onClick={() => check(true)}>
          <RefreshCw size={14} />
          {t('blitz.gpu.checkAgain')}
        </Button>
      </div>
    </div>
  );
}
