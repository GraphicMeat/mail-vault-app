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
