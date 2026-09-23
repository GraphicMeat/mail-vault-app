/**
 * Windows packaging facts no Windows CI checks:
 * - icon.ico must carry every size Windows asks for. It held one 16x16 image,
 *   which Windows blew up for the taskbar, tray and Explorer.
 * - the daemon sidecar must be a GUI-subsystem exe, or it opens a console
 *   window and shows up as an app.
 * - the NSIS installer must stop the daemon before it replaces or removes
 *   mailvault-daemon.exe, and must not wipe per-user registrations on update.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const ico = readFileSync('src-tauri/icons/icon.ico');
const sizes = Array.from({ length: ico.readUInt16LE(4) }, (_, i) => ico[6 + 16 * i] || 256);
const conf = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
const hooksPath = conf.bundle.windows.nsis?.installerHooks;
const hooks = hooksPath ? readFileSync(`src-tauri/${hooksPath}`, 'utf8') : '';
const macro = (name) => hooks.match(new RegExp(`!macro ${name}\\b([\\s\\S]*?)!macroend`))?.[1] ?? '';

describe('Windows icon', () => {
  it('holds every size from 16 to 256', () => {
    for (const size of [16, 24, 32, 48, 64, 256]) expect(sizes).toContain(size);
  });

  it('leads with 32px or larger: Tauri uses the first entry as window and tray icon', () => {
    expect(sizes[0]).toBeGreaterThanOrEqual(32);
  });
});

describe('Windows daemon', () => {
  it('is built for the GUI subsystem, so it never opens a console window', () => {
    const main = readFileSync('src-daemon/src/main.rs', 'utf8');
    const firstItem = main.search(/^(mod|use|fn|pub) /m);
    expect(main.slice(0, firstItem)).toMatch(/#!\[cfg_attr\(windows, windows_subsystem = "windows"\)\]/);
  });
});

describe('Windows installer hooks', () => {
  it('are wired into the NSIS bundle', () => {
    expect(hooksPath).toBe('windows/hooks.nsh');
  });

  it('stop the daemon before install and before uninstall', () => {
    expect(macro('MAILVAULT_KILL_DAEMON')).toMatch(/taskkill \/F \/T \/IM mailvault-daemon\.exe/);
    expect(macro('NSIS_HOOK_PREINSTALL')).toContain('!insertmacro MAILVAULT_KILL_DAEMON');
    expect(macro('NSIS_HOOK_PREUNINSTALL')).toContain('!insertmacro MAILVAULT_KILL_DAEMON');
  });

  it('remove registrations only on a real uninstall, never during an update', () => {
    const un = macro('NSIS_HOOK_PREUNINSTALL');
    const gated = un.slice(un.indexOf('${If} $UpdateMode <> 1'), un.indexOf('${EndIf}'));
    for (const line of un.split('\n').filter((l) => /DeleteReg/.test(l))) {
      expect(gated).toContain(line.trim());
    }
  });

  it('remove exactly the keys the app writes', () => {
    const core = readFileSync('src-core/src/windows_mailto.rs', 'utf8');
    const constant = (name) => core.match(new RegExp(`pub const ${name}: &str = r?"([^"]+)"`))[1];
    const autostart = readFileSync('src-core/src/autostart.rs', 'utf8');
    const runValue = autostart.match(/WINDOWS_RUN_VALUE: &str = "([^"]+)"/)[1];

    expect(hooks).toContain(`DeleteRegKey HKCU "${constant('CLASS_KEY')}"`);
    expect(hooks).toContain(`DeleteRegKey HKCU "${constant('CLIENT_KEY')}"`);
    expect(hooks).toContain(`DeleteRegValue HKCU "${constant('REGISTERED_APPS_KEY')}" "${constant('APP_NAME')}"`);
    expect(hooks).toContain(`DeleteRegValue HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Run" "${runValue}"`);
  });
});
