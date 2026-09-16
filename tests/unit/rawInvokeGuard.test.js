/**
 * Phase 2 Task 2.1: 46 vault/cache/journal/ledger/custody commands move to the
 * daemon under DAEMON_OWNED. `send()` (transport.js) is the only place that
 * checks that set — a raw `window.__TAURI__.core.invoke('maildir_store', ..)`
 * (or the bare `@tauri-apps/api/core` import, or a hand-rolled wrapper around
 * either) bypasses it entirely and throws "command not found" the moment the
 * Tauri command is deleted, one command at a time, silently per call site
 * (most are inside a try/catch).
 *
 * This walks every non-test src/**\/*.{js,jsx} file and flags a call whose
 * target resolves back to a raw Tauri invoke and whose first argument is one
 * of the moved names. It is intentionally NOT a full parser — see the
 * per-pattern comments — but it is scope-aware enough (nearest preceding
 * declaration of the identifier, by line) to tell a raw `invoke` apart from
 * one rebound to `transport.js`'s `send`, which is the one distinction that
 * matters here.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

// ── The 46 moved names (inventory-maildir §1 rows 1-24, inventory-cache §1
// rows 3-20, inventory-custody-plumbing §1) plus Phase 1's DAEMON_OWNED,
// which must stay routed too. ──
const MAILDIR_AND_ATTACHMENT = [
  'maildir_store', 'maildir_read', 'maildir_read_light', 'maildir_read_light_batch',
  'maildir_read_attachment', 'cache_attachment', 'cached_attachment_path', 'prefetch_attachments',
  'maildir_read_raw_source', 'maildir_exists', 'maildir_list', 'maildir_delete',
  'maildir_delete_many', 'maildir_set_flags', 'maildir_storage_stats', 'maildir_clear_cache',
  'maildir_migrate_json_to_eml', 'maildir_migrate_email_dirs', 'maildir_repair_generation',
  'maildir_orphan_stats', 'maildir_purge_orphans',
];
const VAULT_FLAGS = ['vault_apply_flags', 'vault_rename_mailbox', 'vault_adopt_mailbox_dirs'];
const CACHE_JOURNAL_LEDGER_PENDING = [
  'save_email_cache', 'load_email_cache', 'load_email_cache_partial', 'load_email_cache_meta',
  'load_email_cache_by_uids', 'list_cached_uids', 'clear_email_cache',
  'op_journal_queue', 'op_journal_clear', 'op_journal_read',
  'save_mailbox_cache', 'load_mailbox_cache', 'delete_mailbox_cache',
  'graph_allocate_uids', 'load_graph_id_map',
  'read_pending_operation', 'save_pending_operation', 'clear_pending_operation',
];
const CUSTODY = ['local_index_read', 'local_index_append', 'local_index_remove', 'custody_status'];

const PHASE2 = [...MAILDIR_AND_ATTACHMENT, ...VAULT_FLAGS, ...CACHE_JOURNAL_LEDGER_PENDING, ...CUSTODY];

// ── Phase 3 Task 3.1 (inventory-archive-bulk §6 + N6): archive, bulk delete
// and insights. `cancel_bulk_delete` (Task 3.4's new sibling RPC) is a real
// command by Task 3.5, when BulkOperationManager.cancel() first calls it:
// added here so it never ships on a raw invoke undetected (3.1's review
// follow-up A). archive_emails/cancel_archive/bulk_delete_emails/
// verify_archived_emails are DAEMON_OWNED as of Task 3.5; the three
// insights_* names still are not (Task 3.7).
const PHASE3 = [
  'archive_emails', 'cancel_archive', 'bulk_delete_emails', 'verify_archived_emails', 'cancel_bulk_delete',
  'insights_begin_snapshot', 'insights_read_page', 'insights_release_snapshot',
];

// Phase 1's own DAEMON_OWNED set, read from transport.js rather than
// hardcoded, so this guard never drifts from it.
const transportSrc = readFileSync(new URL('../../src/services/transport.js', import.meta.url), 'utf8');
const ownedBlock = transportSrc.slice(
  transportSrc.indexOf('export const DAEMON_OWNED'),
  transportSrc.indexOf(']);', transportSrc.indexOf('export const DAEMON_OWNED')),
);
const PHASE1_OWNED = [...ownedBlock.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);

const GUARDED_NAMES = [...PHASE2, ...PHASE1_OWNED, ...PHASE3];

// ── The scanner ──
//
// Per line, in order: (1) update a flat name -> 'raw' | 'safe' | 'raw-factory'
// map from any declaration on that line, (2) check for a call whose target
// resolves through that map. This is not real scoping — it is "nearest
// preceding declaration of this identifier, anywhere earlier in the file" —
// but every raw-invoke idiom actually used in this codebase re-declares its
// local alias right before use, so it resolves them correctly in practice
// (verified against every real site below and the CI negative control).
function scanText(text, names) {
  const set = new Set(names);
  const lines = text.split('\n');
  const state = new Map();
  // Identifiers already known to reach the daemon correctly — a call through
  // one of these is never raw, however it got its command name.
  const SAFE_NAMES = new Set(['transportSend', 'send', 'tauriInvoke']);
  const DOT = String.raw`(?:\?\.|\.)`;
  const TAURI = String.raw`window\.__TAURI__${DOT}core${DOT}invoke`;
  const RE = {
    // import { invoke } from '@tauri-apps/api/core' — the un-mediated bridge.
    importRaw: /import\s*\{\s*invoke\s*\}\s*from\s*['"]@tauri-apps\/api\/core['"]/,
    // import { send as X } from '.../transport(.js)'
    safeImportAlias: /import\s*\{\s*send\s+as\s+(\w+)\s*\}\s*from\s*['"][^'"]*transport(?:\.js)?['"]/,
    // const X = (cmd, args) => window.__TAURI__?.core?.invoke?.(cmd, args)
    wrapperRaw: new RegExp(String.raw`(?:const|let|var)\s+(\w+)\s*=\s*\([^)]*\)\s*=>\s*${TAURI}\??\.?\(`),
    // const X = () => window.__TAURI__?.core?.invoke  (a factory: calling X()
    // returns the raw invoke fn itself, one hop from being callable)
    factoryRaw: new RegExp(String.raw`(?:const|let|var)\s+(\w+)\s*=\s*\(\)\s*=>\s*${TAURI}\s*;?\s*$`),
    // const X = window.__TAURI__?.core?.invoke;
    directRaw: new RegExp(String.raw`(?:const|let|var)\s+(\w+)\s*=\s*${TAURI}\s*;`),
    // const { invoke } = window.__TAURI__.core;
    destructureRaw: new RegExp(String.raw`(?:const|let|var)\s*\{\s*invoke\s*\}\s*=\s*window\.__TAURI__${DOT}core\b`),
    // const { invoke } = await import('@tauri-apps/api/core'), cleanupEngine.js's
    // shape (:109). No `window.__TAURI__` reference on this line at all, so
    // none of the window-based patterns above ever see it.
    dynamicImportRaw: /(?:const|let|var)\s*\{\s*invoke\s*\}\s*=\s*(?:await\s+)?import\s*\(\s*['"]@tauri-apps\/api\/core['"]\s*\)/,
    // const Y = X();  — resolves Y when X is a known raw factory.
    twoHop: /(?:const|let|var)\s+(\w+)\s*=\s*(\w+)\s*\(\s*\)\s*;/,
    safeWrapper: /(?:const|let|var)\s+(\w+)\s*=\s*\([^)]*\)\s*=>\s*(?:transportSend|send)\s*\(/,
    safeDirect: /(?:const|let|var)\s+(\w+)\s*=\s*(?:transportSend|send)\s*;/,
    // Direct calls with no variable indirection at all.
    inlineRawTauri: new RegExp(String.raw`${TAURI}\s*\(\s*['"]([A-Za-z_]+)['"]`, 'g'),
    inlineRawInternals: /window\.__TAURI_INTERNALS__\??\.invoke\s*\(\s*['"]([A-Za-z_]+)['"]/g,
    // A bare identifier() call — (?<!\.) excludes a member-access call
    // (obj.invoke(...)), which inlineRawTauri already covers on its own.
    genericCall: /(?<!\.)\b(\w+)\s*\(\s*['"]([A-Za-z_]+)['"]/g,
  };

  const hits = [];
  lines.forEach((line, idx) => {
    const lineNo = idx + 1;
    let m;
    if ((m = RE.importRaw.exec(line))) state.set('invoke', 'raw');
    if ((m = RE.safeImportAlias.exec(line))) state.set(m[1], 'safe');
    if ((m = RE.wrapperRaw.exec(line))) state.set(m[1], 'raw');
    else if ((m = RE.factoryRaw.exec(line))) state.set(m[1], 'raw-factory');
    else if ((m = RE.directRaw.exec(line))) state.set(m[1], 'raw');
    if ((m = RE.destructureRaw.exec(line))) state.set('invoke', 'raw');
    if ((m = RE.dynamicImportRaw.exec(line))) state.set('invoke', 'raw');
    if ((m = RE.safeWrapper.exec(line))) state.set(m[1], 'safe');
    else if ((m = RE.safeDirect.exec(line))) state.set(m[1], 'safe');
    if ((m = RE.twoHop.exec(line))) {
      const [, name, rhs] = m;
      if (state.get(rhs) === 'raw-factory') state.set(name, 'raw');
    }

    for (const re of [RE.inlineRawTauri, RE.inlineRawInternals]) {
      re.lastIndex = 0;
      let mm;
      while ((mm = re.exec(line))) {
        const name = mm[1];
        if (set.has(name)) hits.push({ line: lineNo, name, text: line.trim() });
      }
    }

    RE.genericCall.lastIndex = 0;
    let gm;
    while ((gm = RE.genericCall.exec(line))) {
      const [, ident, name] = gm;
      if (!set.has(name)) continue;
      if (SAFE_NAMES.has(ident)) continue;
      if (state.get(ident) === 'raw') hits.push({ line: lineNo, name, text: line.trim() });
    }
  });
  return hits;
}

function scanDir(dir, names) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === '__tests__') continue;
      out.push(...scanDir(full, names));
      continue;
    }
    const ext = extname(entry);
    if (ext !== '.js' && ext !== '.jsx') continue;
    if (entry.endsWith('.test.js') || entry.endsWith('.test.jsx')) continue;
    const text = readFileSync(full, 'utf8');
    for (const h of scanText(text, names)) out.push({ file: full.replace(/\\/g, '/'), ...h });
  }
  return out;
}

describe('raw invoke guard: every Phase 1+2+3 daemon-owned name routes through transport.js', () => {
  it('the guarded name list is exactly 46 Phase 2 names, 8 Phase 3 names, plus the Phase 1 DAEMON_OWNED set', () => {
    expect(PHASE2.length).toBe(46);
    expect(PHASE3.length).toBe(8);
    expect(PHASE1_OWNED.length).toBeGreaterThan(0);
  });

  // Step 2 negative control: a synthetic raw site must be caught, and a
  // synthetic transport-routed site (same identifier name, different
  // binding) must not — proves the guard is not vacuous.
  it('negative control: catches a raw call, ignores a transport-routed one', () => {
    const raw = scanText("const invoke = window.__TAURI__.core.invoke; invoke('maildir_store', {})", ['maildir_store']);
    expect(raw).toHaveLength(1);
    expect(raw[0].name).toBe('maildir_store');

    const routed = scanText("const invoke = transportSend; invoke('maildir_store')", ['maildir_store']);
    expect(routed).toHaveLength(0);
  });

  // Step 2: the dynamic-import shape cleanupEngine.js:109 uses is a different
  // syntax from every other raw-invoke idiom in this file (no `window.__TAURI__`
  // on the line at all) and needs its own pattern, proven here the same way.
  it('negative control: catches the dynamic-import raw shape, ignores the routed replacement', () => {
    const raw = scanText(
      "const { invoke } = await import('@tauri-apps/api/core'); await invoke('archive_emails', {})",
      ['archive_emails'],
    );
    expect(raw).toHaveLength(1);
    expect(raw[0].name).toBe('archive_emails');

    // What Step 3 replaces it with: a direct call through the imported `send`.
    const routed = scanText("await send('archive_emails', {})", ['archive_emails']);
    expect(routed).toHaveLength(0);
  });

  it('no non-test src file raw-invokes a Phase 1, Phase 2 or Phase 3 daemon-owned command', () => {
    const hits = scanDir('src', GUARDED_NAMES);
    expect(hits.map((h) => `${h.file}:${h.line}: ${h.name}`)).toEqual([]);
  });
});
