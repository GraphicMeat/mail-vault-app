// The Blitz email renderer module. Imported once, from src/main.jsx.
// Delete this directory and that import to remove it from the frontend.
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { registerBodyRenderer } from '../../components/email/bodyRendererRegistry';
import { IS_APPSTORE_BUILD } from '../../utils/buildFlags';
import BlitzBody from './BlitzBody';
import SettingsRow from './SettingsRow';
import { installDebugHook } from './surfaces/debugHook';
import { openBlitzWindow, installWindowDocCleanup } from './surfaces/popout';
import { getDocRegistry, onFirstDocAcquire } from './surfaces/docRegistry';
import { rasterizeWithBlitz } from './surfaces/rasterize';
import { useSettingsStore } from '../../stores/settingsStore';
import './blitz.css';

// The Mac App Store shell is built without the render feature (no mvrender
// scheme, so no tile could load) and the sandboxed worker spawn is unproven:
// register nothing there, so neither the setting nor the body exists.
if (!IS_APPSTORE_BUILD) {
  registerBodyRenderer('blitz', { Body: BlitzBody, SettingsRow, openWindow: openBlitzWindow, rasterize: rasterizeWithBlitz });
  installDebugHook(); // e2e builds only

  try {
    const win = getCurrentWebviewWindow();
    // Only the windows this module owns the life of. A compose window may
    // refuse its close (unsaved draft), and closing its docs then would blank it.
    // And only once the window draws a doc: a web-mode window closes as it always did.
    if (win?.label?.startsWith('original-')) {
      onFirstDocAcquire(() => { void installWindowDocCleanup(getDocRegistry(), { win }).catch(() => {}); });
    }
  } catch { /* no Tauri (vitest) */ }

  // Leaving Blitz closes the docs nobody holds, so the worker can idle out.
  let lastMode = useSettingsStore.getState().emailRenderer;
  useSettingsStore.subscribe((s) => {
    if (lastMode === 'blitz' && s.emailRenderer !== 'blitz') getDocRegistry().closeDeferred();
    lastMode = s.emailRenderer;
  });
}
