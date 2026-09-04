import React, { useCallback, useEffect, useState } from 'react';
import { Mail } from 'lucide-react';
import { Button } from '../ui/Button';
import { useT } from '../../i18n/index.js';

// Hint keys the backend returns → catalog keys. The backend never holds copy:
// it reports what the OS did, this maps that to something a person can read.
const HINT_KEYS = {
  macos_mail_app: 'settings.behavior.defaultMail.hintMacosMailApp',
  macos_confirm: 'settings.behavior.defaultMail.hintMacosConfirm',
  windows_settings: 'settings.behavior.defaultMail.hintWindowsSettings',
  linux_manual: 'settings.behavior.defaultMail.hintLinuxManual',
};

const UNKNOWN = { isDefault: false, canSet: false, hint: '' };

/**
 * "Default email app" — whether mail links elsewhere on the system open here.
 *
 * The row reports only what the backend observed. "Make default" is always an
 * *attempt* — on macOS it launches an unsandboxed helper and waits for
 * LaunchServices, on Windows nothing can be done at all — and the backend
 * re-queries afterwards. This re-renders from that answer; nothing here flips
 * optimistically on the click.
 */
export function DefaultMailApp() {
  const t = useT();
  const [status, setStatus] = useState(null);

  const ask = useCallback(async (command) => {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      setStatus(await invoke(command));
    } catch {
      // No backend (browser preview, an older build): the row goes quiet rather
      // than taking the settings page down with it.
      setStatus(UNKNOWN);
    }
  }, []);

  useEffect(() => { ask('mailto_default_status'); }, [ask]);

  // The OS may put a consent dialog in front of the change, which takes focus.
  // When focus comes back, ask again rather than leave a stale "no" on screen.
  const stale = status && !status.isDefault;
  useEffect(() => {
    if (!stale) return undefined;
    const onFocus = () => ask('mailto_default_status');
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [stale, ask]);

  if (!status) return null;

  const hintKey = HINT_KEYS[status.hint];

  return (
    <div className="bg-mail-surface border border-mail-border rounded-xl p-5">
      <h4 className="font-semibold text-mail-text mb-4 flex items-center gap-2">
        <Mail size={18} className="text-mail-accent-text" />
        {t('settings.behavior.defaultMail.title')}
      </h4>

      <p className="text-sm text-mail-text-muted mb-4">
        {t('settings.behavior.defaultMail.description')}
      </p>

      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div
          data-testid="default-mail-state"
          data-default={String(!!status.isDefault)}
          className="text-sm text-mail-text"
        >
          {status.isDefault
            ? t('settings.behavior.defaultMail.isDefault')
            : t('settings.behavior.defaultMail.notDefault')}
        </div>

        {!status.isDefault && (
          <Button
            data-testid="default-mail-action"
            data-action={status.canSet ? 'set' : 'howto'}
            onClick={() => ask('mailto_make_default')}
          >
            {status.canSet
              ? t('settings.behavior.defaultMail.makeDefault')
              : t('settings.behavior.defaultMail.checkAgain')}
          </Button>
        )}
      </div>

      {!status.isDefault && hintKey && (
        <p data-testid="default-mail-hint" className="text-sm text-mail-text-muted mt-3">
          {t(hintKey)}
        </p>
      )}
    </div>
  );
}
