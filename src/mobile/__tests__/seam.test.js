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
const ALLOWED_INVOKES = ['daemon_rpc', 'mobile_log', 'mobile_open_file', 'mobile_share_file'];
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
    expect(invokes.filter((c) => !ALLOWED_INVOKES.includes(c))).toEqual([]);
  });

  it('open_and_share_are_the_only_file_commands', async () => {
    const { invokes } = await analyzeSeam(ENTRY);
    expect(invokes.filter((c) => c.startsWith('mobile_') && c.endsWith('_file')).sort()).toEqual(['mobile_open_file', 'mobile_share_file']);
    // The shell's own plugin registers no commands JS could reach.
    expect(invokes.filter((c) => c.startsWith('plugin:'))).toEqual([]);
  });

  it('no_desktop_only_modules', async () => {
    const { modules } = await analyzeSeam(ENTRY);
    expect(modules.length).toBeGreaterThan(1);
    expect(modules.filter((m) => DESKTOP_ONLY.test(m))).toEqual([]);
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
