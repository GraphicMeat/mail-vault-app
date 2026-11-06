// Fixture for seam.test.js `detector_really_detects`: a desktop-only plugin plus a desktop RPC.
// Never imported by the mobile bundle.
import { Command } from '@tauri-apps/plugin-shell';
import { daemonCall } from '../../../services/daemonClient.js';

export const leak = () => [Command, daemonCall('backup.run')];
