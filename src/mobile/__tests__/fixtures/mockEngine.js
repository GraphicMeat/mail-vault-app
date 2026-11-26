// A fake phone shell and engine behind `window.__TAURI__` (transport.js calls through it): every
// RPC a settings page asks answered with a plausible reply, in the reply shapes the engine's own
// page tests use. Three accounts (one with a very long address), tags, fields, views, auto-tag
// rules, local drafts and Premium on. `installMockEngine()` installs it and returns `{ unhandled, emit }`:
// `unhandled` names every method it had no answer for.
export function installMockEngine(SHOT = { theme: 'light', palette: 'indigo' }) {
  const now = Date.now();
  const MB = 1024 * 1024;
  const DAY = 86400000;
  const unhandled = new Set();
  const listeners = [];

  const ACCOUNTS = [
    { id: 'a1', email: 'ada@example.test', displayName: 'Ada Lovelace', kind: 'imap', oauth: false, imapHost: 'imap.example.test', imapPort: 993, security: 'ssl', smtpHost: 'smtp.example.test', smtpPort: 465, smtpSecurity: 'ssl' },
    { id: 'g1', email: 'grace.hopper@gmail.com', displayName: 'Grace Hopper', kind: 'imap', provider: 'google', oauth: true, imapHost: 'imap.gmail.com', imapPort: 993, security: 'ssl', smtpHost: 'smtp.gmail.com', smtpPort: 465, smtpSecurity: 'ssl' },
    { id: 'a3', email: 'bartholomew.fitzgerald-longname@mail.subdomain.example-company.test', displayName: 'Bartholomew Fitzgerald-Longname', kind: 'imap', oauth: false, imapHost: 'imap.subdomain.example-company.test', imapPort: 993, security: 'ssl', smtpHost: 'smtp.subdomain.example-company.test', smtpPort: 587, smtpSecurity: 'starttls' },
  ];
  const FOLDERS = [
    { path: 'INBOX', name: 'INBOX', specialUse: '\\Inbox', unseen: 7, total: 42, depth: 0, noselect: false },
    { path: 'Drafts', name: 'Drafts', specialUse: '\\Drafts', unseen: 0, total: 2, depth: 0, noselect: false },
    { path: 'Sent', name: 'Sent', specialUse: '\\Sent', unseen: 0, total: 310, depth: 0, noselect: false },
    { path: 'Archive', name: 'Archive', specialUse: '\\Archive', unseen: 0, total: 1200, depth: 0, noselect: false },
    { path: 'Junk', name: 'Junk', specialUse: '\\Junk', unseen: 3, total: 9, depth: 0, noselect: false },
    { path: 'Trash', name: 'Trash', specialUse: '\\Trash', unseen: 0, total: 14, depth: 0, noselect: false },
    { path: 'Projects', name: 'Projects', specialUse: null, unseen: 1, total: 20, depth: 0, noselect: false },
    { path: 'Projects/Alpha', name: 'Alpha', specialUse: null, unseen: 1, total: 8, depth: 1, noselect: false },
  ];
  const SENDERS = [['Ann Lee', 'ann@example.com'], ['Stripe', 'receipts@stripe.test'], ['GitHub', 'noreply@github.test'], ['Marta Kowalska-Wiśniewska', 'marta.kowalska@very-long-company-name.example'], ['Bob', 'bob@x.test'], ['Weekly Digest', 'digest@news.test']];
  const SUBJECTS = ['Quarterly report is ready for review', 'Your receipt from Acme Inc. #2291-8841', '[mail-vault] Fix the delete error on a gone uid (#812)', 'Re: Lunch on Thursday? Also a very long subject line that will not fit on a phone', 'Invoice 2026-11', 'This week: 12 stories you missed'];
  const ROWS = Array.from({ length: 24 }, (_, i) => ({
    uid: 100 - i, accountId: 'a1', folder: 'INBOX', dateMs: now - i * 5 * 3600000,
    subject: SUBJECTS[i % 6], fromName: SENDERS[i % 6][0], fromAddress: SENDERS[i % 6][1],
    to: [{ name: 'Ada Lovelace', address: 'ada@example.test' }],
    snippet: 'Hi Ada, here is the summary you asked for. The numbers are up eleven percent on last quarter and the team would like to walk you through them.',
    seen: i % 3 !== 0, flagged: i % 5 === 1, hasAttachments: i % 4 === 1,
    threadCount: i === 2 ? 4 : 1, threadUids: i === 2 ? [98, 97, 96, 95] : [100 - i], threadUnread: i === 2 ? 1 : 0, threadFlagged: false,
  }));
  let TAGS = [
    { id: 't1', name: 'Work', color: '#6366f1', position: 0, count: 12 },
    { id: 't2', name: 'Receipts', color: '#16a34a', position: 1, count: 5 },
    { id: 't3', name: 'Follow up later this week', color: '', position: 2, count: 2 },
  ];
  const tagsFor = (uid) => (uid % 4 === 0 ? ['t1', 't2', 't3'] : uid % 3 === 0 ? ['t2'] : uid % 5 === 0 ? ['t1'] : []);
  const FIELDS = [
    { id: 'f1', scope: '*', name: 'Priority', kind: 'select', position: 0, options: [{ id: 'hi', label: 'High', color: '#ff0000' }, { id: 'lo', label: 'Low', color: '' }] },
    { id: 'f2', scope: '*', name: 'Done', kind: 'checkbox', position: 1, options: [] },
    { id: 'f3', scope: 'a1', name: 'Project name', kind: 'text', position: 2, options: [] },
  ];
  let VIEWS = [
    { id: 'builtin-starred', name: '', icon: 'star', builtin: 'starred', position: 0, def: { starred: true } },
    { id: 'v1', name: 'Bills', icon: 'tag', builtin: null, position: 1, def: { query: 'invoice' } },
    { id: 'v2', name: 'Newsletters from this month', icon: 'tag', builtin: null, position: 2, def: { query: 'digest' } },
  ];
  let RULES = [
    { id: 'r1', name: 'Receipts', instruction: 'receipts and invoices from shops and services', constraints: { fromDomain: 'shop.example' }, tagId: 't2', inboxAction: 'hide', minConfidence: 0.7, allowRemote: false, provider: null, enabled: true, enabledAt: now - DAY, createdAt: now - 9 * DAY, updatedAt: now - DAY },
    { id: 'r2', name: 'Work mail that needs a reply', instruction: 'messages from colleagues that ask me a question', constraints: {}, tagId: 't1', inboxAction: 'keep', minConfidence: 0.8, allowRemote: false, provider: null, enabled: false, enabledAt: null, createdAt: now - 5 * DAY, updatedAt: now - 2 * DAY },
  ];
  let prefs = { theme: SHOT.theme, palette: SHOT.palette, templates: [{ name: 'Thanks', body: 'Thank you, I will get back to you tomorrow.' }, { name: 'Out of office', body: 'I am away until Monday.' }], aiEnabled: true, aiEndpointUrl: 'https://ai.example.test/v1', aiEndpointModel: 'local-model' };
  let settings = { notifications: 'on', notificationPreview: true, backgroundDownload: true };
  const acctSettings = {};
  // The long account has an alias too, so compose shows its From picker at its widest.
  const ALIASES = {
    a1: [{ address: 'ada.alias@example.test', name: 'Ada (alias)' }],
    a3: [{ address: 'b.fitzgerald-longname.support@mail.subdomain.example-company.test', name: 'Bartholomew Fitzgerald-Longname (Support desk)' }],
  };
  const NO_LIMIT = { limitBytes: null, isProviderDefault: false, defaultCapOn: null, defaultCapOff: null };
  const usageEntry = (id, over = {}) => ({
    accountId: id, measured: true, today: { down: 90 * MB, up: 1 * MB }, week: { down: 300 * MB, up: 5 * MB }, month: { down: 900 * MB, up: 9 * MB }, year: { down: 2000 * MB, up: 20 * MB },
    limits: { gmail: id === 'g1', capEnabled: id === 'g1', warnEnabled: true, down: { ...NO_LIMIT, limitBytes: 100 * MB }, up: { ...NO_LIMIT } },
    typed: { dailyDownLimitBytes: 100 * MB, dailyUpLimitBytes: null }, paused: false, warning: null, ...over,
  });
  const offlineEntry = (id, over = {}) => ({ accountId: id, window: '3m', effectiveWindow: '3m', bodiesBytes: 48 * MB, attachmentsBytes: 120 * MB, messages: 4000, offline: 1200, foldersLeft: 2, ...over });
  const NET = [
    { atMs: now - 1000, direction: 'out', protocol: 'imap', host: 'imap.example.test', port: 993, purpose: 'sync', account: 'ada@example.test', bytesUp: 100, bytesDown: 2048, durationMs: 120, result: 'ok', country: 'US' },
    { atMs: now - 2000, direction: 'out', protocol: 'https', host: 'mailvaultapp.com', port: 443, purpose: 'billing', account: null, bytesUp: 10, bytesDown: 20, durationMs: 80, result: 'HTTP 500', country: 'DE' },
    { atMs: now - 60000, direction: 'out', protocol: 'imap', host: 'imap.subdomain.example-company.test', port: 993, purpose: 'sync', account: ACCOUNTS[2].email, bytesUp: 5000, bytesDown: 9000000, durationMs: 4200, result: 'ok', country: 'LT' },
  ];
  // The phone's own (local) drafts: two of `a1`, one of `g1` (the drawer's one Drafts and the
  // Drafts folder's local rows show the open account's only).
  let DRAFTS = [
    { id: 'drf_00000000000000a1', accountId: 'a1', to: 'ann@example.com', subject: 'Notes from Tuesday', text: 'Here are the notes.', updatedMs: now - 20 * 60000 },
    { id: 'drf_00000000000000a2', accountId: 'a1', to: '', subject: '', text: 'Remember to', updatedMs: now - 3 * 3600000 },
    { id: 'drf_00000000000000g1', accountId: 'g1', to: 'bob@x.test', subject: 'Re: Lunch on Thursday?', text: 'Thursday works.', updatedMs: now - DAY },
  ];
  const HTML = '<div style="font-family:sans-serif"><p>Hi Ada,</p><p>Here is the summary you asked for. The numbers are up eleven percent on last quarter and the team would like to walk you through them on Thursday.</p><p>Best,<br>Ann</p></div>';

  function rpc(method, p = {}) {
    switch (method) {
      case 'mobile.ping': return { engine: 'visual-mock', schema: 6, perfGate: false };
      case 'mobile.accounts.list': return { accounts: ACCOUNTS };
      case 'mobile.accounts.update': return { ok: true, account: ACCOUNTS.find((a) => a.id === p.accountId) || {} };
      case 'mobile.folders.list': return { folders: FOLDERS };
      case 'mobile.messages.page': return p.cursor ? { rows: [], nextCursor: null, total: ROWS.length, listGen: 1 } : { rows: ROWS.map((r) => ({ ...r, accountId: p.accountId || r.accountId })), nextCursor: null, total: ROWS.length, listGen: 1 };
      case 'mobile.messages.thread': return { rows: ROWS.slice(2, 6) };
      case 'mobile.message.body': return { html: HTML, text: null, attachments: [], remoteImages: 0, trackers: 0, gone: false };
      case 'mobile.message.inlineImages': return { images: {}, missing: [] };
      case 'mobile.outbox.list': return [];
      case 'mobile.drafts.list': return DRAFTS.map(({ text, ...d }) => d);
      case 'mobile.drafts.get': { const d = DRAFTS.find((x) => x.id === p.id); return d ? { cc: '', bcc: '', inReplyTo: '', references: '', attachments: [], ...d } : null; }
      case 'mobile.drafts.delete': DRAFTS = DRAFTS.filter((d) => d.id !== p.id); return { deleted: true };
      case 'mobile.followup.list': return { items: [] };
      case 'mobile.actions.pending': return {
        pending: p.accountId && p.accountId !== 'a1' ? [] : [
          { seq: 7, accountId: 'a1', folder: 'INBOX', kind: 'delete', uids: [3, 4], state: 'retrying', lastError: 'HOST_UNREACHABLE', attempts: 2, createdMs: now - 3600000 },
          { seq: 8, accountId: 'a1', folder: 'Archive', kind: 'seen', uids: [5], state: 'queued', lastError: null, attempts: 0, createdMs: now - 600000 },
        ],
      };
      case 'mobile.actions.retry': case 'mobile.sync.refresh': case 'mobile.offline.downloadNow': return { queued: true };
      case 'mobile.actions.apply': return { queued: 1, skipped: [] };
      case 'mobile.prefs.get': return { ...prefs };
      case 'mobile.prefs.set': prefs = { ...prefs, ...p }; return { ...prefs };
      case 'mobile.settings.get': return { ...settings };
      case 'mobile.settings.set': settings = { ...settings, ...p }; return { ...settings };
      case 'mobile.accountSettings.get': {
        const a = ACCOUNTS.find((x) => x.id === p.accountId) || {};
        return { accountId: p.accountId, notify: true, displayName: a.displayName || '', hidden: false, signature: null, sendAs: '', aliases: ALIASES[p.accountId] || [], sentFolder: null, color: null, ...(acctSettings[p.accountId] || {}) };
      }
      case 'mobile.accountSettings.set': acctSettings[p.accountId] = { ...(acctSettings[p.accountId] || {}), ...(p.values || {}) }; return rpc('mobile.accountSettings.get', p);
      case 'mobile.app.state': return {};
      case 'mobile.premium.status': return { premium: true, source: 'apple', expiresMs: now + 200 * DAY };
      case 'mobile.premium.refresh': return { premium: true, source: 'apple', expiresMs: now + 200 * DAY };
      case 'mobile.premium.devices': return { available: true, limit: 5, devices: [
        { key: 'k-phone', name: 'MailVault for iPhone', platform: 'ios', appVersion: '2.24.0', lastSeenMs: now, current: true },
        { key: 'k-mac', name: 'Bartholomew’s MacBook Pro 16-inch (2026)', platform: 'macos', appVersion: '2.23.1', lastSeenMs: now - 2 * 3600000, current: false }] };
      case 'mobile.tags.list': return { tags: TAGS };
      case 'mobile.tags.forMessages': return { tags: (p.items || []).map((i) => tagsFor(i.uid)) };
      case 'mobile.tags.assign': case 'mobile.tags.unassign': return { count: (p.items || []).length };
      case 'mobile.fields.list': return { fields: FIELDS.filter((f) => !p.accountId || f.scope === '*' || f.scope === p.accountId) };
      case 'mobile.fields.values': return { values: (p.items || []).map((i) => (i.uid % 2 === 0 ? { f1: 'hi', f2: true, f3: 'Apollo' } : {})) };
      case 'mobile.fields.optionUsage': return { usage: { hi: 3 } };
      case 'mobile.views.list': return { views: VIEWS };
      case 'mobile.views.counts': return { counts: { 'builtin-starred': 4, v1: 12, v2: 128 } };
      case 'mobile.views.evaluate': return { available: true, total: 6, cursor: null, rows: ROWS.slice(0, 6) };
      case 'mobile.views.suggestSenders': return { senders: [{ address: 'ann@example.com', name: 'Ann Lee', count: 12 }, { address: 'receipts@stripe.test', name: 'Stripe', count: 5 }] };
      case 'mobile.views.suggestTerms': return { terms: [] };
      case 'mobile.autoTags.list': return { rules: RULES };
      case 'mobile.autoTags.status': return { configured: true, leavesDevice: true, googleSkipped: ['g1'], backfills: {} };
      case 'mobile.autoTags.preview': return { candidates: [{ accountId: 'a1', folder: 'INBOX', mailbox: 'INBOX', uid: 1, subject: 'Your receipt from Acme Inc.', matched: true, confidence: 0.9, refused: null }] };
      case 'mobile.ai.status': return { hasKey: true, reviewed: false };
      case 'mobile.ai.quickReplies': return { replies: [] };
      case 'mobile.storage.get': return {
        accounts: [{ accountId: 'a1', messages: 4000, bodiesBytes: 48 * MB, attachmentsBytes: 120 * MB }, { accountId: 'g1', messages: 12000, bodiesBytes: 300 * MB, attachmentsBytes: 900 * MB }, { accountId: 'a3', messages: 12, bodiesBytes: 3 * MB, attachmentsBytes: 1 * MB }],
        databaseBytes: 80 * MB, searchBytes: 22 * MB, logsBytes: 4096, cacheBytes: 10 * MB, totalBytes: 1484 * MB,
      };
      case 'mobile.offline.get': return { premium: true, network: { constrained: false, expensive: true }, accounts: [offlineEntry('a1'), offlineEntry('g1', { window: '12m', effectiveWindow: '12m' }), offlineEntry('a3', { window: 'all', effectiveWindow: 'all' })] };
      case 'mobile.offline.set': return rpc('mobile.offline.get').accounts.find((a) => a.accountId === p.accountId);
      case 'mobile.search.status': return { available: true, state: 'idle', indexed: 15800, total: 16012, sizeBytes: 22 * MB };
      case 'mobile.search.local': return { rows: ROWS.slice(0, 5), cursor: null };
      case 'mobile.deleted.list': return { rows: [
        { id: 'b1', accountId: 'a1', mailbox: 'INBOX', uid: 7, deletedAt: now - 3600000, hasEml: true, row: { subject: 'Quarterly report', from: { name: 'Ann Lee', address: 'ann@example.com' }, date: now - 7 * DAY } },
        { id: 'b2', accountId: 'a3', mailbox: 'Projects/Alpha', uid: 9, deletedAt: now - 7200000, hasEml: false, row: { subject: 'A very long subject line of a deleted message that will need to wrap or truncate', from: { name: 'Marta Kowalska-Wiśniewska', address: 'marta.kowalska@very-long-company-name.example' }, date: now - 9 * DAY } },
      ], next: null };
      case 'mobile.dataUsage.get': return { accounts: [usageEntry('a1'), usageEntry('g1'), usageEntry('a3', { measured: false })] };
      case 'mobile.dataUsage.set': return usageEntry(p.accountId);
      case 'mobile.logs.get': { const text = Array.from({ length: 40 }, (_, i) => `2026-11-19T10:00:${String(i).padStart(2, '0')}.000Z [sync] a1 INBOX fetched ${i} new, idle; next pass in 300s (host imap.example.test)`).join('\n'); return { text, bytes: text.length }; }
      case 'mobile.netActivity.list': return { events: NET, countries: [{ country: 'US', connections: 1, bytesUp: 100, bytesDown: 2048, hosts: ['imap.example.test'] }, { country: 'DE', connections: 1, bytesUp: 10, bytesDown: 20, hosts: ['mailvaultapp.com'] }, { country: 'LT', connections: 1, bytesUp: 5000, bytesDown: 9000000, hosts: ['imap.subdomain.example-company.test'] }], summary: { hosts: 3, sent: 5110, received: 9002068, accounts: ['ada@example.test', ACCOUNTS[2].email] }, retention: 'week' };
      case 'mobile.netActivity.setRetention': return { retention: p.retention };
      case 'mobile.tracking.stats': return { messages: 214, pixels: 388, top: [['Mailchimp', 120], ['HubSpot', 64], ['SendGrid', 31]], patterns: 1234 };
      case 'mobile.pgp.listKeys': return { keys: [{ fingerprint: 'ABCD1234EF567890ABCD1234EF567890ABCD1234', userIds: ['Bob Example <bob@x.test>'], created: 1700000000 }] };
      case 'mobile.unsubscribe.list': return { senders: [
        { accountId: 'a1', address: 'news@news.test', name: 'News', folder: 'INBOX', lastMs: now - 1000, count: 4, method: 'one-click' },
        { accountId: 'g1', address: 'letters@letters.test', name: '', folder: 'INBOX', lastMs: now - 5000, count: 1, method: 'browser' },
        { accountId: 'a3', address: 'promotions-and-offers@marketing.very-long-company-name.example', name: 'Very Long Company Name Promotions', folder: 'INBOX', lastMs: now - 3 * DAY, count: 212, method: 'mailto' },
      ], history: [{ address: 'old@spam.test', accountId: 'a1', unsubscribedAt: now - 2 * DAY, method: 'one-click', status: 'ok' }] };
      default:
        if (!unhandled.has(method)) { unhandled.add(method);  }
        return {};
    }
  }

  async function invoke(cmd, args = {}) {
    switch (cmd) {
      case 'daemon_rpc': return structuredClone(rpc(args.method, args.params || {}));
      case 'mobile_log': return null;
      case 'mobile_notification_take': return null;
      case 'mobile_notifications_permission': return { granted: true };
      case 'mobile_store_products': return [];
      case 'mobile_store_restore': return [];
      case 'mobile_app_icon': return null;
      default: unhandled.add(`cmd:${cmd}`); return null;
    }
  }
  window.__TAURI__ = {
    core: { invoke },
    event: { listen: async (name, cb) => { listeners.push([name, cb]); return () => {}; } },
  };
  window.__MV_MOCK = { unhandled, emit: (name, payload) => listeners.forEach(([, cb]) => cb({ payload: { name, payload } })) };
  return window.__MV_MOCK;
}
