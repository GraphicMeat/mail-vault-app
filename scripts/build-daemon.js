/**
 * Build script for the mailvault-daemon sidecar.
 *
 * Cargo builds the daemon as a workspace binary; this script copies the
 * resulting binary into src-tauri/binaries/ with the target-triple suffix
 * Tauri's `externalBin` expects.
 *
 * The legacy Bun-compiled `mailvault-server` sidecar was removed in 2026-05;
 * all IMAP/SMTP/OAuth2 logic now lives in the Rust Tauri process. See
 * src-tauri/src/commands.rs and src-tauri/src/oauth2.rs.
 */

import { copyFileSync, mkdirSync, existsSync, chmodSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const outputDir = join(rootDir, 'src-tauri', 'binaries');

if (!existsSync(outputDir)) {
  mkdirSync(outputDir, { recursive: true });
}

const platform = process.platform;
const arch = process.arch;
const tauriTarget = process.env.TAURI_TARGET;
const binaryExt = platform === 'win32' ? '.exe' : '';

let targetTriple;
if (tauriTarget) {
  targetTriple = tauriTarget;
} else if (platform === 'darwin') {
  targetTriple = arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
} else if (platform === 'win32') {
  targetTriple = 'x86_64-pc-windows-msvc';
} else {
  targetTriple = arch === 'arm64' ? 'aarch64-unknown-linux-gnu' : 'x86_64-unknown-linux-gnu';
}

// Windows uses TCP for the daemon-frontend IPC (Unix sockets unavailable).
// The daemon code currently #cfg-gates the Unix socket path; the Windows
// build is wired but not yet packaged.
if (platform === 'win32') {
  console.log('Skipping daemon build on Windows (Unix-socket IPC not packaged yet)');
  process.exit(0);
}

console.log('Building mailvault-daemon...');
const cargoProfile = process.env.DAEMON_PROFILE || 'release';
const cargoTarget = tauriTarget || '';
const cargoTargetFlag = cargoTarget ? `--target ${cargoTarget}` : '';
execSync(
  `cargo build -p mailvault-daemon --${cargoProfile} ${cargoTargetFlag}`.replace(/\s+/g, ' ').trim(),
  { stdio: 'inherit', cwd: rootDir }
);

const targetSubdir = cargoTarget
  ? join('target', cargoTarget, cargoProfile)
  : join('target', cargoProfile);
const builtBin = join(rootDir, targetSubdir, `mailvault-daemon${binaryExt}`);

if (!existsSync(builtBin)) {
  console.error(`Daemon binary not found at ${builtBin}`);
  process.exit(1);
}

const sidecarName = `mailvault-daemon-${targetTriple}${binaryExt}`;
const sidecarPath = join(outputDir, sidecarName);
copyFileSync(builtBin, sidecarPath);
chmodSync(sidecarPath, '755');
console.log(`Daemon staged: src-tauri/binaries/${sidecarName}`);
