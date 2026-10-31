import React, { useCallback, useEffect, useState } from 'react';
import { ExternalLink, RefreshCw } from 'lucide-react';
import { useT } from '../../i18n/index.js';
import { useSettingsStore } from '../../stores/settingsStore';
import { SettingRow } from '../../components/ui/SettingRow';
import { ToggleSwitch } from '../../components/ui/ToggleSwitch';
import { Button } from '../../components/ui/Button';
import { openInBrowser } from '../../services/billingApi';
import { gpuStatusRender } from './service';

// Each vendor's locale segment per app locale, checked against the live sites.
// AMD has no Italian driver page; the Arch wiki and Ubuntu docs are English only.
const SITE_LOCALES = {
  microsoft: { en: 'en-us', de: 'de-de', es: 'es-es', fr: 'fr-fr', it: 'it-it', 'pt-BR': 'pt-br', ja: 'ja-jp', ko: 'ko-kr', 'zh-Hans': 'zh-cn' },
  nvidia: { en: 'en-us', de: 'de-de', es: 'es-es', fr: 'fr-fr', it: 'it-it', 'pt-BR': 'pt-br', ja: 'ja-jp', ko: 'ko-kr', 'zh-Hans': 'zh-cn' },
  amd: { en: 'en', de: 'de', es: 'es', fr: 'fr', 'pt-BR': 'pt', ja: 'ja', ko: 'ko', 'zh-Hans': 'zh-cn' },
  intel: { en: 'us/en', de: 'de/de', es: 'es/es', fr: 'fr/fr', it: 'it/it', 'pt-BR': 'br/pt', ja: 'jp/ja', ko: 'kr/ko', 'zh-Hans': 'cn/zh' },
};
const site = (vendor, locale) => SITE_LOCALES[vendor][locale] ?? SITE_LOCALES[vendor].en;

const LINKS = {
  windowsDrivers: (l) => `https://support.microsoft.com/${site('microsoft', l)}/windows/update-drivers-through-device-manager-in-windows-ec62f46c-ff14-c91d-eead-d7126dc1f7b6`,
  nvidia: (l) => `https://www.nvidia.com/${site('nvidia', l)}/drivers/`,
  amd: (l) => `https://www.amd.com/${site('amd', l)}/support/download/drivers.html`,
  intel: (l) => `https://www.intel.com/content/www/${site('intel', l)}/support/intel-driver-support-assistant.html`,
  vulkanLinux: () => 'https://wiki.archlinux.org/title/Vulkan',
  ubuntuNvidia: () => 'https://documentation.ubuntu.com/server/how-to/graphics/install-nvidia-drivers/',
};
const OS_LINKS = {
  windows: ['windowsDrivers', 'nvidia', 'amd', 'intel'],
  linux: ['vulkanLinux', 'ubuntuNvidia', 'nvidia'],
  mac: [], // Metal is built in
};

/** Where a user gets what the graphics-card renderer needs, as [catalog key, url] in the app's language. */
export function gpuLinks(os, locale = 'en') {
  return OS_LINKS[os].map((name) => [`blitz.gpu.link.${name}`, LINKS[name](locale)]);
}

/** wgpu's backend names as people know the APIs. */
const API_NAMES = { Dx12: 'DirectX 12', Metal: 'Metal', Vulkan: 'Vulkan' };

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
  if (p.ok) return ['blitz.gpu.found', { adapter: p.adapter || '?', backend: API_NAMES[p.backend] || p.backend || '?' }];
  return [reasonKey(p.reason)];
}

/** Settings > Appearance, under the Rust renderer: draw its tiles on the graphics card. */
export default function GpuRow() {
  const t = useT();
  const on = useSettingsStore(s => s.blitzGpu === true);
  const setBlitzGpu = useSettingsStore(s => s.setBlitzGpu);
  const locale = useSettingsStore(s => s.language) || 'en';
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
        {OS_LINKS[os].length > 0 && (
          <div className="flex flex-wrap gap-2">
            {gpuLinks(os, locale).map(([key, url]) => (
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
