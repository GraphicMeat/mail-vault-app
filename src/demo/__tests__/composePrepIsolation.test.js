import { it, expect, vi } from 'vitest';
// Importing the demo backend precedes installDemoGlobals. Persisted stores or
// the live mail graph here would hydrate before its transport exists.
vi.mock('../../stores/settingsStore', () => { throw new Error('demo backend imported live settings'); });
vi.mock('../../stores/mailStore', () => { throw new Error('demo backend imported live mail'); });
import { createDemoBackend } from '../backend';
it('prepares complete long messages without importing live UI stores', async () => {
  const backend = createDemoBackend();
  const call = params => backend.invoke('daemon_rpc', { method: 'compose.reply_context', params });
  const html = '界'.repeat(750000) + 'FINAL';
  const result = await call({ kind: 'message', requestId: 'demo-isolated', mode: 'forward', accountId: backend.accounts[0].id,
    original: { header: { subject: 'long', bcc: [{ address: 'hidden@example.test' }] }, html },
    presentation: { originalLabel: 'Original', dateLabel: 'today', subjectCandidate: 'Fwd: long' },
    selectedQuoteHtml: '<p>selection</p>',
    threadContext: Array.from({ length: 70 }, (_, i) => ({ original: { header: {}, html: `<p>${i}</p>` }, dateLabel: `${i}` })),
  });
  expect(result.fullOriginalHtml.endsWith(html)).toBe(true); expect(result.quotedHtml.endsWith(html)).toBe(true);
  expect(result.contextHtml).toContain('<p>69</p>'); expect(JSON.stringify(result)).not.toContain('hidden@example.test');
});

it('runs actual demo.check in isolation with backend settings/account/version and injected clock', async () => {
  let clock = Date.parse('2026-10-25T00:00:20Z');
  const backend = createDemoBackend({ now: () => clock, initialSettings: { 'mailvault-settings': { state: { billingProfile: { hasSubscription: true, status: 'active' } } } } });
  const request = { requestId: 'check-isolated', expectedSettingsVersion: 0, draftId: 'issued', revision: 4, accountId: backend.accounts[0].id, fromAddress: 'me@example.test', mode: 'new', to: 'friend@example.test', cc: '', bcc: 'authored@example.test', subject: '', authoredBodyText: '界\\"'.repeat(400000) + ' attached', attachmentCount: 0, sendPlan: null, scheduleDraft: null, timeZone: 'UTC', sendAnyway: false };
  const call = p => backend.invoke('daemon_rpc', { method: 'compose.check', params: { ...request, ...p } });
  const before = backend.snapshot();
  const base = { requestId: request.requestId, settingsVersion: 0, draftId: 'issued', revision: 4 };
  expect(await call({})).toEqual({ ...base, kind: 'confirm_attachment' });
  expect(await call({ sendAnyway: true })).toEqual({ ...base, kind: 'ready', route: { delay: null } });
  expect(await call({ to: '', accountId: 'gone' })).toMatchObject({ kind: 'invalid', key: 'compose.pleaseEnterLeastOneRecipient' });
  expect(await call({ to: 'bad-to', cc: 'bad-cc', accountId: 'gone' })).toMatchObject({ key: 'compose.invalidRecipient', args: { address: 'bad-to' } });
  expect(await call({ cc: 'bad-cc', bcc: 'bad-bcc' })).toMatchObject({ args: { address: 'bad-cc' } });
  expect(await call({ bcc: 'bad-bcc' })).toMatchObject({ args: { address: 'bad-bcc' } });
  expect(await call({ accountId: 'gone' })).toMatchObject({ key: 'compose.noAccountSelected' });
  expect(await call({ sendAnyway: true, sendPlan: { kind: 'in', minutes: 6 } })).toMatchObject({ route: { draft: { localTime: '2026-10-25T00:07', tz: 'UTC' } } });
  clock += 60000;
  expect(await call({ sendAnyway: true, sendPlan: { kind: 'at' }, scheduleDraft: { localTime: '2026-10-25T00:01', tz: 'UTC' } })).toMatchObject({ key: 'scheduled.picker.pastTime' });
  await expect(call({ expectedSettingsVersion: 1 })).rejects.toThrow('errors.settingsConflict');
  await expect(call({ premium: true })).rejects.toThrow('compose.preparationUnavailable');
  expect(backend.snapshot()).toEqual(before);
});
it.each([
  { attachmentReminder: false, billingProfile: { hasSubscription: true, status: 'active' } }, {},
  { billingProfile: { hasSubscription: true, clientAccessGranted: false, premiumAccess: true, status: 'active' } },
])('demo check honors backend reminder and entitlement settings %j', async state => {
  const backend = createDemoBackend({ initialSettings: { 'mailvault-settings': { state } } });
  const result = await backend.invoke('daemon_rpc', { method: 'compose.check', params: { requestId: 'policy', accountId: backend.accounts[0].id, fromAddress: '', mode: 'new', to: 'friend@example.test', authoredBodyText: 'attached', attachmentCount: 0, timeZone: 'UTC' } });
  expect(result).toMatchObject({ kind: 'ready', route: { delay: null } });
});

it('matches the immutable check policy and route cases through the actual isolated backend', async () => {
  const { readFileSync } = await import('node:fs');
  const fixture = JSON.parse(readFileSync('src-core/tests/fixtures/compose-prep-cases.json', 'utf8'));
  const now = 1792886400000;
  const settings = { attachmentReminder: true, billingProfile: { hasSubscription: true, status: 'active' } };
  const backend = createDemoBackend({ now: () => now, initialSettings: { 'mailvault-settings': { state: settings } } });
  const base = { requestId: 'fixture-check', accountId: backend.accounts[0].id, fromAddress: '', mode: 'new', to: 'friend@example.test', authoredBodyText: '', attachmentCount: 0, timeZone: 'UTC' };
  for (const c of fixture.cases) {
    const call = p => backend.invoke('daemon_rpc', { method: 'compose.check', params: { ...base, ...p } });
    if (c.category === 'invalid') {
      const out = await call({ to: c.input });
      if (!c.input.trim()) expect(out.key, c.name).toBe('compose.pleaseEnterLeastOneRecipient');
      else if (c.output.length) expect(out.args.address, c.name).toBe(c.output[0]);
      else expect(out.kind, c.name).toBe('ready');
    } else if (c.category === 'attachment' || c.category === 'authored') {
      const out = await call({ mode: c.input.mode, subject: c.input.subject, authoredBodyText: c.input.bodyText, attachmentCount: c.input.attachmentCount });
      expect(out.kind === 'confirm_attachment', c.name).toBe(c.category === 'authored' ? c.output.missing : c.output);
    } else if (c.category === 'route') {
      const routed = createDemoBackend({ now: () => c.input.now });
      const out = await routed.invoke('daemon_rpc', { method: 'compose.check', params: { ...base, sendPlan: c.input.plan, scheduleDraft: c.input.scheduleDraft, timeZone: c.input.timeZone } });
      expect(out.route, c.name).toEqual(c.output);
    } else if (c.category === 'premium') {
      const entitled = createDemoBackend({ now: () => c.input.now, initialSettings: { 'mailvault-settings': { state: c.input.state } } });
      const out = await entitled.invoke('daemon_rpc', { method: 'compose.check', params: { ...base, authoredBodyText: 'attached' } });
      expect(out.kind === 'confirm_attachment', c.name).toBe(c.output);
    }
  }
});
