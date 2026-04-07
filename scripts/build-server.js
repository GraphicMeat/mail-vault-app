/**
 * Build script for the MailVault server
 * 
 * This script bundles the Node.js server and prepares it for Tauri sidecar.
 * 
 * For production builds, you'll need to compile to a native binary using one of:
 * 1. pkg: npm install -g @yao-pkg/pkg && pkg server-bundle.cjs
 * 2. bun: bun build server/index.js --compile --outfile mailvault-server
 * 3. nexe: npm install -g nexe && nexe server-bundle.cjs
 */

import { build } from 'esbuild';
import { writeFileSync, mkdirSync, existsSync, copyFileSync, chmodSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const outputDir = join(rootDir, 'src-tauri', 'binaries');

// Ensure output directory exists
if (!existsSync(outputDir)) {
  mkdirSync(outputDir, { recursive: true });
}

async function buildServer() {
  console.log('📦 Bundling server code...');

  // Embed OAuth2 credentials at build time so the sidecar doesn't need env vars
  const define = {};
  if (process.env.MAILVAULT_MS_CLIENT_ID) {
    define['process.env.MAILVAULT_MS_CLIENT_ID'] = JSON.stringify(process.env.MAILVAULT_MS_CLIENT_ID);
    console.log('   ✓ Embedding MAILVAULT_MS_CLIENT_ID');
  }
  if (process.env.MAILVAULT_MS_CLIENT_SECRET) {
    define['process.env.MAILVAULT_MS_CLIENT_SECRET'] = JSON.stringify(process.env.MAILVAULT_MS_CLIENT_SECRET);
    console.log('   ✓ Embedding MAILVAULT_MS_CLIENT_SECRET');
  }

  // Bundle the server code
  await build({
    entryPoints: [join(rootDir, 'server', 'index.js')],
    bundle: true,
    platform: 'node',
    target: 'node18',
    outfile: join(outputDir, 'server-bundle.cjs'),
    format: 'cjs',
    external: [
      // Native modules that can't be bundled
    ],
    define,
    minify: true,
    sourcemap: false,
  });
  
  console.log('✅ Server bundled to src-tauri/binaries/server-bundle.cjs');
  
  // Detect platform — allow override via TAURI_TARGET env var for cross-compilation in CI
  const platform = process.platform;
  const arch = process.arch;
  const tauriTarget = process.env.TAURI_TARGET;

  // Tauri expects binaries named with target triple
  // macOS: mailvault-server-aarch64-apple-darwin or mailvault-server-x86_64-apple-darwin
  // Windows: mailvault-server-x86_64-pc-windows-msvc.exe
  // Linux: mailvault-server-x86_64-unknown-linux-gnu

  let targetTriple;
  let binaryExt = '';

  if (tauriTarget) {
    targetTriple = tauriTarget;
    if (tauriTarget.includes('windows')) binaryExt = '.exe';
  } else if (platform === 'darwin') {
    targetTriple = arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
  } else if (platform === 'win32') {
    targetTriple = 'x86_64-pc-windows-msvc';
    binaryExt = '.exe';
  } else {
    targetTriple = arch === 'arm64' ? 'aarch64-unknown-linux-gnu' : 'x86_64-unknown-linux-gnu';
  }
  
  const sidecarName = `mailvault-server-${targetTriple}${binaryExt}`;
  const sidecarPath = join(outputDir, sidecarName);
  
  // Check if Bun is available for native compilation
  let compiled = false;
  
  try {
    console.log('🔨 Attempting to compile with Bun...');
    // Map target triple to Bun's --target flag for cross-compilation
    let bunTarget = '';
    if (targetTriple === 'x86_64-apple-darwin') {
      bunTarget = '--target=bun-darwin-x64';
    } else if (targetTriple === 'aarch64-apple-darwin') {
      bunTarget = '--target=bun-darwin-arm64';
    } else if (targetTriple === 'x86_64-unknown-linux-gnu') {
      bunTarget = '--target=bun-linux-x64';
    } else if (targetTriple === 'aarch64-unknown-linux-gnu') {
      bunTarget = '--target=bun-linux-arm64';
    }
    // Build --define flags to embed OAuth2 credentials in the binary
    const bunDefines = Object.entries(define)
      .map(([k, v]) => `--define "${k}=${v.replace(/"/g, '\\"')}"`)
      .join(' ');
    execSync(`bun build ${join(rootDir, 'server', 'index.js')} --compile ${bunTarget} ${bunDefines} --outfile "${sidecarPath}"`, {
      stdio: 'inherit',
      cwd: rootDir
    });
    compiled = true;
    console.log(`✅ Compiled native binary: ${sidecarName}`);
  } catch (e) {
    console.log('ℹ️  Bun not available, trying pkg...');
  }
  
  if (!compiled) {
    try {
      console.log('🔨 Attempting to compile with pkg...');
      const pkgTarget = platform === 'darwin' 
        ? (arch === 'arm64' ? 'node18-macos-arm64' : 'node18-macos-x64')
        : platform === 'win32'
          ? 'node18-win-x64'
          : 'node18-linux-x64';
      
      execSync(`npx @yao-pkg/pkg ${join(outputDir, 'server-bundle.cjs')} -t ${pkgTarget} -o "${sidecarPath}"`, {
        stdio: 'inherit',
        cwd: rootDir
      });
      compiled = true;
      console.log(`✅ Compiled native binary: ${sidecarName}`);
    } catch (e) {
      console.log('ℹ️  pkg not available');
    }
  }
  
  if (!compiled) {
    // Create a shell script wrapper as fallback
    console.log('⚠️  No native compiler available. Creating shell script wrapper...');
    console.log('   For production, install Bun (recommended) or pkg:');
    console.log('   - Bun: curl -fsSL https://bun.sh/install | bash');
    console.log('   - pkg: npm install -g @yao-pkg/pkg');
    
    if (platform === 'win32') {
      // Windows batch file
      const batchContent = `@echo off
node "%~dp0server-bundle.cjs" %*
`;
      writeFileSync(sidecarPath, batchContent);
    } else {
      // Unix shell script
      const shellContent = `#!/bin/bash
DIR="$( cd "$( dirname "\${BASH_SOURCE[0]}" )" && pwd )"
node "$DIR/server-bundle.cjs" "$@"
`;
      writeFileSync(sidecarPath, shellContent);
      chmodSync(sidecarPath, '755');
    }
    
    console.log(`✅ Created wrapper script: ${sidecarName}`);
    console.log('   Note: This requires Node.js to be installed on the target system.');
  }
  
  console.log('\n🎉 Server build complete!');
  console.log(`   Output: src-tauri/binaries/${sidecarName}`);

  // ── Build and stage mailvault-daemon (Rust sidecar) ───────────────────────
  // The daemon is a separate Rust binary in the workspace. Cargo builds it to
  // target/<profile>/mailvault-daemon, and we copy it into src-tauri/binaries/
  // with the target-triple suffix so Tauri's externalBin bundles it correctly.

  const daemonSidecarName = `mailvault-daemon-${targetTriple}${binaryExt}`;
  const daemonSidecarPath = join(outputDir, daemonSidecarName);

  // Skip on Windows — daemon uses Unix sockets
  if (platform !== 'win32') {
    console.log('\n🔧 Building mailvault-daemon...');

    const cargoProfile = process.env.DAEMON_PROFILE || 'release';
    const cargoTarget = tauriTarget || ''; // empty = host target
    const cargoTargetFlag = cargoTarget ? `--target ${cargoTarget}` : '';

    try {
      execSync(
        `cargo build -p mailvault-daemon --${cargoProfile} ${cargoTargetFlag}`.replace(/\s+/g, ' ').trim(),
        { stdio: 'inherit', cwd: rootDir }
      );

      // Locate the built binary
      const targetSubdir = cargoTarget ? join('target', cargoTarget, cargoProfile) : join('target', cargoProfile);
      const builtBin = join(rootDir, targetSubdir, `mailvault-daemon${binaryExt}`);

      if (existsSync(builtBin)) {
        copyFileSync(builtBin, daemonSidecarPath);
        chmodSync(daemonSidecarPath, '755');
        console.log(`✅ Daemon staged: src-tauri/binaries/${daemonSidecarName}`);
      } else {
        console.error(`⚠️  Daemon binary not found at ${builtBin}`);
        console.error('   The Tauri bundle will not include the daemon.');
      }
    } catch (e) {
      console.error('⚠️  Failed to build mailvault-daemon:', e.message);
      console.error('   The Tauri bundle will not include the daemon.');
    }
  } else {
    console.log('\nℹ️  Skipping daemon build (Unix sockets not supported on Windows)');
  }
}

buildServer().catch(console.error);
