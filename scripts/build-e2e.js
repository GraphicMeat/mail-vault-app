/**
 * Build what the e2e suite runs, on any OS: the frontend with VITE_E2E=1, the
 * debug daemon staged as the app's sidecar (a stale staged one would be copied
 * over the fresh build), and the app with the webdriver feature.
 */
import { execSync } from 'node:child_process';
import { join } from 'node:path';

const run = (cmd, env = {}) => execSync(cmd, { stdio: 'inherit', env: { ...process.env, ...env } });

run('npm run build', { VITE_E2E: '1' });
run('npm run build:daemon', { DAEMON_PROFILE: 'debug' });
run('cargo build -p mailvault --features webdriver',
  process.platform === 'darwin' ? { SPARKLE_FRAMEWORK_PATH: join(process.cwd(), 'src-tauri') } : {});
