// @vitest-environment node
// The mobile bundle may only reach RPC methods the mobile engine implements, the Tauri commands
// the mobile shell implements, and no desktop-only module. Proven statically on the real entry.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { analyzeSeam } from '../seam.js';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const ENTRY = here('../main.jsx');
const METHODS = JSON.parse(readFileSync(here('../../../src-mobile-engine/methods.json'), 'utf8'));
const EVENTS = JSON.parse(readFileSync(here('../../../src-mobile-engine/events.json'), 'utf8'));
const ALLOWED_INVOKES = ['daemon_rpc', 'mobile_auth_close', 'mobile_auth_open', 'mobile_log', 'mobile_notification_take', 'mobile_notifications_permission', 'mobile_open_file', 'mobile_pick_files', 'mobile_share_file', 'mobile_store_products', 'mobile_store_purchase', 'mobile_store_restore'];
// The camera: the official barcode scanner plugin's own commands (scanner.js), and nothing else of it.
const SCANNER_INVOKES = ['plugin:barcode-scanner|cancel', 'plugin:barcode-scanner|check_permissions', 'plugin:barcode-scanner|open_app_settings', 'plugin:barcode-scanner|request_permissions', 'plugin:barcode-scanner|scan'];
// A plugin command other than the scanner's.
const otherPlugin = (c) => c.startsWith('plugin:') && !SCANNER_INVOKES.includes(c);
// Desktop stores (and `plugin-fs`) would bring the desktop RPC graph with them.
const DESKTOP_ONLY = /plugin-shell|plugin-updater|plugin-fs|sparkle|features\/blitz|e2eMotion|src\/stores\//i;

describe('mobile seam', () => {
  it('every_rpc_method_is_implemented', async () => {
    const { rpcMethods } = await analyzeSeam(ENTRY);
    expect(rpcMethods.length).toBeGreaterThan(0);
    expect(rpcMethods.filter((m) => !METHODS.includes(m))).toEqual([]);
  });

  it('only_daemon_rpc_is_invoked', async () => {
    const { invokes } = await analyzeSeam(ENTRY);
    expect(invokes.length).toBeGreaterThan(0);
    expect(invokes.filter((c) => !ALLOWED_INVOKES.includes(c) && !SCANNER_INVOKES.includes(c))).toEqual([]);
  });

  it('the_camera_is_reached_through_the_barcode_scanner_commands_only', async () => {
    const { invokes } = await analyzeSeam(ENTRY);
    expect(invokes.filter((c) => c.startsWith('plugin:'))).toEqual(SCANNER_INVOKES);
    expect(invokes.filter((c) => !c.startsWith('plugin:') && /scan|camera/.test(c))).toEqual([]);
  });

  it('open_and_share_are_the_only_file_commands', async () => {
    const { invokes } = await analyzeSeam(ENTRY);
    expect(invokes.filter((c) => c.startsWith('mobile_') && c.endsWith('_file')).sort()).toEqual(['mobile_open_file', 'mobile_share_file']);
    // The shell's own plugin registers no commands JS could reach.
    expect(invokes.filter(otherPlugin)).toEqual([]);
  });

  it('pick_files_is_the_only_picker_command', async () => {
    const { invokes } = await analyzeSeam(ENTRY);
    expect(invokes).toContain('mobile_pick_files');
    expect(invokes.filter((c) => /pick/.test(c))).toEqual(['mobile_pick_files']);
    // Still no plugin command: the picker is reached through the shell only.
    expect(invokes.filter(otherPlugin)).toEqual([]);
  });

  it('the_auth_sheet_is_opened_and_closed_through_the_shell_only', async () => {
    const { invokes } = await analyzeSeam(ENTRY);
    expect(invokes.filter((c) => /auth/.test(c))).toEqual(['mobile_auth_close', 'mobile_auth_open']);
    expect(invokes.filter(otherPlugin)).toEqual([]);
  });

  it('the_store_is_reached_through_the_three_shell_commands_only', async () => {
    const { invokes } = await analyzeSeam(ENTRY);
    expect(invokes.filter((c) => /store/.test(c))).toEqual(['mobile_store_products', 'mobile_store_purchase', 'mobile_store_restore']);
    expect(ALLOWED_INVOKES).toHaveLength(12);
    expect(invokes.filter(otherPlugin)).toEqual([]);
  });

  it('no_desktop_only_modules', async () => {
    const { modules } = await analyzeSeam(ENTRY);
    expect(modules.length).toBeGreaterThan(1);
    expect(modules.filter((m) => DESKTOP_ONLY.test(m))).toEqual([]);
  });

  it('shared_pure_modules_are_in_the_mobile_graph', async () => {
    const { modules } = await analyzeSeam(ENTRY);
    const shared = modules.filter((m) => m.startsWith('src/shared/'));
    expect(shared.length).toBeGreaterThan(0);
    // src/shared is the one desktop-side directory both apps may import; it is held pure by
    // src/shared/__tests__/purity.test.js, so none of it can pull a store or service in.
    expect(shared.filter((m) => DESKTOP_ONLY.test(m))).toEqual([]);
  });

  it('detector_really_detects', async () => {
    const r = await analyzeSeam(here('./fixtures/desktopLeak.js'));
    expect(r.modules.filter((m) => DESKTOP_ONLY.test(m)).length).toBeGreaterThan(0);
    // daemonClient lazy-loads the desktop settings store: the store pattern sees it too.
    expect(r.modules.filter((m) => /src\/stores\//.test(m)).length).toBeGreaterThan(0);
    expect(r.rpcMethods).toContain('backup.run');
    expect(r.rpcMethods.filter((m) => !METHODS.includes(m))).toContain('backup.run');
  });

  it('detector_sees_optional_chained_global_invoke', async () => {
    const r = await analyzeSeam(ENTRY);
    expect(r.invokes).toContain('mobile_log');
  });

  it('dynamic_calls_are_listed_empty', async () => {
    const { dynamicCalls } = await analyzeSeam(ENTRY);
    expect(dynamicCalls).toEqual([]);
    const fx = await analyzeSeam(here('./fixtures/dynamicCall.js'));
    expect(fx.dynamicCalls.length).toBeGreaterThan(0);
  });

  it('every_listened_event_is_emitted', async () => {
    const real = await analyzeSeam(ENTRY);
    expect(real.listens.length).toBeGreaterThan(0);
    expect(real.listens.filter((n) => !EVENTS.includes(n))).toEqual([]);
    const fx = await analyzeSeam(here('./fixtures/listenEvents.js'));
    expect(fx.listens).toEqual(['mobile.nope', 'mobile.sync.state']);
    expect(fx.listens.filter((n) => !EVENTS.includes(n))).toEqual(['mobile.nope']);
  });

  it('aliased_calls_are_caught', async () => {
    const fx = await analyzeSeam(here('./fixtures/aliasedCall.js'));
    const text = fx.dynamicCalls.join('\n');
    expect(text).toMatch(/daemonCall/);
    expect(text).toMatch(/invoke/);
    expect(text).toMatch(/listen/);
    expect(fx.dynamicCalls.length).toBeGreaterThanOrEqual(4);
  });
});
