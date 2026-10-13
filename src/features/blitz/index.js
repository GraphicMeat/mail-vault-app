// The Blitz email renderer module. Imported once, from src/main.jsx.
// Delete this directory and that import to remove it from the frontend.
import { registerBodyRenderer } from '../../components/email/bodyRendererRegistry';
import BlitzBody from './BlitzBody';
import SettingsRow from './SettingsRow';

registerBodyRenderer('blitz', { Body: BlitzBody, SettingsRow });
