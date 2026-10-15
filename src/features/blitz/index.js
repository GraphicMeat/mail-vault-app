// The Blitz email renderer module. Imported once, from src/main.jsx.
// Delete this directory and that import to remove it from the frontend.
import { registerBodyRenderer } from '../../components/email/bodyRendererRegistry';
import { IS_APPSTORE_BUILD } from '../../utils/buildFlags';
import BlitzBody from './BlitzBody';
import SettingsRow from './SettingsRow';
import { installDebugHook } from './surfaces/debugHook';
import './blitz.css';

// The Mac App Store shell is built without the render feature (no mvrender
// scheme, so no tile could load) and the sandboxed worker spawn is unproven:
// register nothing there, so neither the setting nor the body exists.
if (!IS_APPSTORE_BUILD) {
  registerBodyRenderer('blitz', { Body: BlitzBody, SettingsRow });
  installDebugHook(); // e2e builds only
}
