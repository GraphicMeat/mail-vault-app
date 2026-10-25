// Source oracle only: real JS exports, scripted IO, no MIME/filesystem claim.
import { it, expect, vi } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const h = vi.hoisted(() => ({ trace: [], state: {}, cached: null, entry: null, eml: null, built: null, bytes: [], storage: null, fail: null }));
const copy = v => JSON.parse(JSON.stringify(v));
vi.mock('../../../../src/services/api', () => ({
  buildDraftMime: async (...args) => { h.trace.push(['build', ...copy(args)]); return h.built; },
  appendLocalIndex: async (...args) => { h.trace.push(['index', ...copy(args)]); },
  removeFromLocalIndex: async (...args) => { h.trace.push(['removeIndex', ...copy(args)]); },
}));
vi.mock('../../../../src/services/db', () => ({
  getCachedMailboxes: async id => { h.trace.push(['cachedMailboxes', id]); if (h.fail === 'cache') throw Error('cache unavailable'); return h.cached; },
  getLocalIndexEntry: async (...args) => { h.trace.push(['entry', ...args]); return h.entry; },
  getLocalEmailFull: async (...args) => { h.trace.push(['body', ...args]); return h.eml; },
}));
vi.mock('../../../../src/services/transport', () => ({ send: async (...args) => {
  h.trace.push(['rpc', ...copy(args)]);
  if (h.fail === args[0]) throw Error('scripted IO failure');
  return h.bytes;
} }));
vi.mock('../../../../src/stores/mailStore', () => ({ useMailStore: {
  getState: () => h.state,
  setState: update => { h.state = { ...h.state, ...(typeof update === 'function' ? update(h.state) : update) }; },
} }));
vi.mock('../../../../src/stores/safeStorage', () => ({ safeStorage: {
  getItem: async () => h.storage, setItem: (_key, value) => { h.storage = value; }, removeItem: () => { h.storage = null; },
} }));
import { resolveDraftsMailbox, saveLocalDraft, draftToInitialData, openLocalDraft, setComposeOpener, discardDraftFor, newDraftUid, scheduledEmlToInitialData } from '../../../../src/services/localDrafts';
import { withAttachmentBytes } from '../../../../src/services/attachmentUtils';
import { saveComposeSession, loadComposeSession, mergeComposeSession } from '../../../../src/services/composeSession';
import { replyWireHtml } from '../../../../src/utils/quoteWire';
const account = { id: 'one', email: 'one@example.test', name: 'Owner' };
const identity = { accountId: 'one', mailbox: 'Legacy/Entwürfe', uid: 42 };
const payload = { to: '"Doe, Jane" <jane@example.test>, next@example.test', cc: 'copy@example.test', bcc: 'blind@example.test', subject: 'Draft', html: '<p>Words</p>', text: 'Words', inReplyTo: '<parent@example.test>', references: '<root@example.test> <parent@example.test>', attachments: [{ filename: 'inline.png', contentType: 'image/png', content: 'AAEC', cid: 'logo', encoding: 'base64' }] };
const eml = { subject: 'Draft', from: { address: 'one@example.test' }, to: [{ address: 'jane@example.test', name: 'Doe, Jane' }], cc: [{ address: 'copy@example.test' }], bcc: [{ address: 'blind@example.test' }], html: replyWireHtml('<p>Words</p>', '<p>Original<img src="cid:logo"></p>', true), text: 'Words', attachments: [{ filename: 'inline.png', contentType: 'image/png', content: 'AAEC', size: 3, contentId: '<logo>' }] };
const reset = () => {
  h.trace = []; h.state = { activeAccountId: 'one', activeMailbox: identity.mailbox, localEmails: [], emails: [], archivedEmailIds: new Set(), savedEmailIds: new Set() };
  h.cached = null; h.entry = null; h.eml = null; h.fail = null; h.bytes = []; h.built = { rawBase64: 'c2NyaXB0ZWQgbWltZQ==', messageId: '<fixed@example.test>' };
};
const visible = () => ({ localEmails: h.state.localEmails, emails: h.state.emails, archivedEmailIds: [...h.state.archivedEmailIds], savedEmailIds: [...h.state.savedEmailIds] });
it('freezes actual local draft and session outputs', async () => {
  // Historical pre-port oracle. Never regenerate it from the native adapter.
  // The actual source hashes and unsafe outcomes remain evidence of that era;
  // current adapter/component behavior has its own behavioral tests.
  const frozenBytes = readFileSync(new URL('../local-draft-cases.json', import.meta.url));
  expect(createHash('sha256').update(frozenBytes).digest('hex')).toBe('6322a8d6c43dec742bb588c0c50cb5c4b4728cb9347aacb4bf74e42819e4895d');
  const frozen = JSON.parse(frozenBytes);
  if (Object.entries(frozen.source.files).some(([path, hash]) => createHash('sha256').update(readFileSync(path)).digest('hex') !== hash)) {
    expect(process.env.MAILVAULT_GENERATE_DRAFT_FIXTURE, 'Capture only from the original pre-port source checkout').not.toBe('1');
    return;
  }

  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-25T00:00:00.000Z'));
  vi.stubGlobal('window', { __TAURI__: { core: { invoke() {} } } });
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const cases = [];
  const record = (name, input, output) => cases.push({ name, input: copy(input), output: copy(output), trace: copy(h.trace) });
  try {
    for (const c of [
      { name: 'active-nested-role-before-name', active: 'one', list: [{ name: 'Drafts', path: 'Decoy' }, { path: 'Folders', children: [{ name: 'Entwürfe', path: 'Folders/Entwürfe', special_use: '\\Drafts' }] }] },
      { name: 'cached-role', active: 'other', cached: [{ path: '[Gmail]/Drafts', specialUse: '\\Drafts' }] },
      { name: 'case-insensitive-name', active: 'one', list: [{ path: 'custom', name: 'dRaFtS' }] },
      { name: 'literal-fallback', active: 'other' },
      { name: 'cache-error-fallback', active: 'other', fail: 'cache' },
    ]) { reset(); h.state.activeAccountId = c.active; h.state.mailboxes = c.list; h.cached = c.cached; h.fail = c.fail; record(c.name, c, await resolveDraftsMailbox('one')); }
    for (const c of [
      { name: 'complete-alias-threaded-attachment', payload },
      { name: 'no-recipients', payload: { to: '', cc: '', bcc: '', subject: '', html: '', text: '', inReplyTo: '', references: '', attachments: [] } },
      { name: 'missing-MIME-no-write', payload, missing: true },
    ]) {
      reset(); if (c.missing) h.built = {};
      const input = { ...identity, account, fromAddress: 'alias@example.test', displayName: 'Alias', payload: c.payload, snippet: 's'.repeat(210), hasAttachments: !!c.payload.attachments.length };
      const entry = await saveLocalDraft(input); record(c.name, input, { entry, visible: visible() });
    }
    for (const c of [
      { name: 'forward-quote-CID-threading-legacy', eml },
      { name: 'text-fallback-escape', eml: { ...eml, html: '', text: '<keep> & text\r\nline', attachments: [] } },
      { name: 'empty-body', eml: { ...eml, html: '', text: '', attachments: [] } },
    ]) { reset(); const input = { ...identity, entry: { from: { address: 'alias@example.test' }, in_reply_to: payload.inReplyTo, references: payload.references }, eml: c.eml }; record(c.name, input, draftToInitialData(input)); }
    for (const c of [
      { name: 'reopen-legacy', source: 'local_draft', flags: ['archived', 'seen', 'draft'] },
      { name: 'unsafe-staged-send-also-opens', source: 'local_draft', flags: ['seen', 'draft'] },
      { name: 'server-archive-refused', source: 'server' },
      { name: 'local-sent-refused', source: 'local_sent' },
      { name: 'missing-body-refused', source: 'local_draft', missing: true },
    ]) {
      reset(); h.entry = { source: c.source, flags: c.flags, in_reply_to: payload.inReplyTo, references: payload.references }; h.eml = c.missing ? null : eml;
      const opened = []; setComposeOpener(data => opened.push(copy(data))); const result = await openLocalDraft(identity.accountId, identity.mailbox, identity.uid);
      record(c.name, { ...identity, entry: h.entry, eml: h.eml }, { result, opened });
    }
    for (const c of [
      { name: 'provided-bytes-CID-order', attachments: payload.attachments },
      { name: 'grouped-source-indices', attachments: [2, 0].map(i => ({ filename: `f${i}`, contentType: 'application/octet-stream', cid: `c${i}`, _source: { ...identity, attachmentIndex: i } })), bytes: ['Ag==', 'AA=='] },
      { name: 'unsafe-empty-supplied-content', attachments: [{ filename: 'empty', contentType: 'application/octet-stream', content: '' }] },
      { name: 'missing-source-bytes', attachments: [{ filename: 'gone', _source: { ...identity, attachmentIndex: 0 } }], bytes: [] },
    ]) {
      reset(); h.bytes = c.bytes; let output; try { output = { attachments: await withAttachmentBytes(c.attachments) }; } catch (error) { output = { error: error.message }; }
      record(c.name, c, output);
    }
    for (const fail of [null, 'maildir_delete']) {
      reset(); h.fail = fail; h.state.localEmails = [{ uid: 42, _accountId: 'one', _mailbox: identity.mailbox }];
      const saved = { _accountId: 'one', _draftUid: 42, _draftMailbox: identity.mailbox }; await discardDraftFor(saved);
      record(fail ? 'unsafe-discard-hides-on-IO-failure' : 'discard-exact-identity', saved, visible());
    }
    reset(); await discardDraftFor({ _accountId: 'one' }); record('unsaved-discard-noop', {}, null);
    reset();
    const windows = [{ id: 1, initialData: { subject: 'old' }, snapshot: { to: '', cc: '', bcc: '', subject: '', body: '<p>baseline</p>', attachments: [], ...{ _accountId: 'one', _draftUid: 42, _draftMailbox: identity.mailbox } }, detached: true, nativeLabel: 'child' }, { id: 2 }];
    saveComposeSession(windows); const restored = await loadComposeSession(); record('latest-baseline-snapshot-normalization', windows, { stored: JSON.parse(h.storage), restored });
    const current = [{ id: 1, initialData: { subject: 'opened before hydration' } }]; record('hydrate-id-collision', { current, restored }, mergeComposeSession(current, restored));
    for (const raw of ['{bad', '{}']) { h.storage = raw; record('invalid-session-' + raw, raw, await loadComposeSession()); }
    saveComposeSession([]); record('clear-empty-session', [], { storage: h.storage });
    reset(); const scheduledInput = { row: { id: 'scheduled-1', accountId: 'one', uid: 99, mailbox: 'Scheduled', localTime: '2026-10-26T12:00', tz: 'Europe/Vilnius', envelope: JSON.stringify({ from: 'alias@example.test', remindDays: 3 }) }, eml: { ...eml, rawSource: btoa('In-Reply-To: <parent@example.test>\r\nReferences: <root@example.test>\r\n <parent@example.test>\r\n\r\nbody') } };
    record('scheduled-no-draft-identity', scheduledInput, scheduledEmlToInitialData(scheduledInput));
    const uids = [newDraftUid(), newDraftUid()]; record('same-webview-clock-counter', {}, { uids, distinct: new Set(uids).size === 2 });
    const files = ['src/services/localDrafts.js', 'src/services/composeSession.js', 'src/services/attachmentUtils.js', 'src/components/ComposeModal.jsx', 'src/App.jsx', 'src/utils/quoteWire.js', 'src/stores/slices/unifiedHelpers.js'];
    const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');
    const fixture = { schemaVersion: 1, boundary: 'Actual JS mappings and orchestration under scripted dependency replies. Not MIME, filesystem, or component durability proof.', source: { snapshotCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), files: Object.fromEntries(files.map(path => [path, sha(path)])), generatorSha256: sha(new URL(import.meta.url)) }, unsafeCases: ['unsafe-staged-send-also-opens', 'unsafe-empty-supplied-content', 'unsafe-discard-hides-on-IO-failure'], cases };
    const path = new URL('../local-draft-cases.json', import.meta.url);
    if (process.env.MAILVAULT_GENERATE_DRAFT_FIXTURE === '1') {
      const bytes = Buffer.from(JSON.stringify(fixture, null, 2) + '\n'); writeFileSync(path, bytes);
      console.log('LOCAL_DRAFT_FIXTURE_BASE64_BEGIN'); console.log(bytes.toString('base64')); console.log('LOCAL_DRAFT_FIXTURE_BASE64_END');
    } else {
      const saved = JSON.parse(readFileSync(path, 'utf8')); expect(fixture.cases).toEqual(saved.cases); expect(fixture.source.files).toEqual(saved.source.files); expect(fixture.source.generatorSha256).toBe(saved.source.generatorSha256);
    }
    expect(cases.length).toBe(30);
  } finally { warning.mockRestore(); setComposeOpener(null); vi.unstubAllGlobals(); vi.useRealTimers(); }
});
