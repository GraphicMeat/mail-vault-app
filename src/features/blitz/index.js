// The Blitz email renderer module. Imported once, from src/main.jsx.
// Delete this directory and that import to remove it from the frontend.
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { registerBodyRenderer } from '../../components/email/bodyRendererRegistry';
import BlitzBody from './BlitzBody';
import SettingsRow from './SettingsRow';
import { installDebugHook } from './surfaces/debugHook';
import { openBlitzWindow, installWindowDocCleanup } from './surfaces/popout';
import { getDocRegistry, onFirstDocAcquire } from './surfaces/docRegistry';
import { rasterizeWithBlitz } from './surfaces/rasterize';
import { compositeBlitzBodies } from './surfaces/compositeBodies';
import { useSettingsStore } from '../../stores/settingsStore';
import './blitz.css';

// Registered in every build, the Mac App Store one included: the setting stays
// off by default, and a worker that cannot start shows the failure bubble.
{
  registerBodyRenderer('blitz', { Body: BlitzBody, SettingsRow, openWindow: openBlitzWindow, rasterize: rasterizeWithBlitz, compositeBodies: compositeBlitzBodies });
  installDebugHook(); // e2e builds only
  // e2e builds only, and loaded lazily: the surface builders it imports (ChatBubbleView, through it EmailViewer)
  // must not join the entry chunk of every window.
  if (import.meta.env.VITE_E2E === '1') import('./surfaces/surfaceDocs').then((m) => m.installSurfaceDocsHook()).catch(() => {});
  // The thread and chat perf gate's probe (tests/e2e/connected-blitz-perf.test.js): e2e builds only, lazy for the same reason.
  if (import.meta.env.VITE_E2E === '1') import('./surfaces/perfProbe').then((m) => m.installPerfProbe()).catch(() => {});

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
  // A tick later: this subscriber fires before React unmounts the bodies, and a
  // body that unmounts after the sweep defers its close (thread, bubble).
  let lastMode = useSettingsStore.getState().emailRenderer;
  useSettingsStore.subscribe((s) => {
    if (lastMode === 'blitz' && s.emailRenderer !== 'blitz') setTimeout(() => getDocRegistry().closeDeferred(), 0);
    lastMode = s.emailRenderer;
  });
}
