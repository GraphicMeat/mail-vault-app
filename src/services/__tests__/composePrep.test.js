import { describe, it, expect, vi } from 'vitest';
const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('../transport', () => ({ send }));
vi.mock('../../utils/dateFormat', () => ({ formatDateTime: d => `date:${d}` }));
import { messagePreparation, prepareCompose } from '../composePrep';
import { prepareDemoCompose } from '../../demo/composePrep';
const accounts = [{ id: 'one', email: 'me@example.test' }];
const replyTo = { uid: 1, from: { address: 'writer@example.test' }, bcc: [{ address: 'hidden@example.test' }], subject: 'test', date: 'today', html: '<p>body</p>' };
describe('native compose preparation adapter', () => {
  it('projects complete large inputs without Bcc or unsupported identity fields', async () => {
    const large = '界<&'.repeat(750000) + 'FINAL';
    const context = Array.from({ length: 70 }, (_, i) => ({ ...replyTo, html: `<p>${i}</p>`, date: `${i}` }));
    const input = messagePreparation({ replyTo: { ...replyTo, html: large, _threadContext: context }, mode: 'forward', accountId: 'one' });
    expect(input.original.header).not.toHaveProperty('bcc'); expect(input.original).not.toHaveProperty('uid');
    expect(input.threadContext).toHaveLength(70); expect(input.threadContext[69].dateLabel).toBe('date:69');
    const acknowledge = vi.fn().mockResolvedValue(4);
    send.mockImplementation(async (_, p) => prepareDemoCompose(p, { accounts, values: {}, version: 4 }));
    const result = await prepareCompose(input, { acknowledge });
    expect(result.fullOriginalHtml.endsWith(large)).toBe(true); expect(result.contextHtml).toContain('<p>69</p>');
    expect(send.mock.calls.at(-1)[1].expectedSettingsVersion).toBe(4);
  });
  it('refuses a result after identity changes or a native sender fallback', async () => {
    const input = messagePreparation({ replyTo, mode: 'reply', accountId: 'one' });
    let current = true;
    send.mockImplementation(async (_, p) => { current = false; return prepareDemoCompose(p, { accounts, values: {}, version: 2 }); });
    await expect(prepareCompose(input, { acknowledge: async () => 2, isCurrent: () => current })).rejects.toThrow('compose.preparationUnavailable');
    send.mockImplementation(async (_, p) => prepareDemoCompose(p, { accounts: [{ id: 'different' }], values: {}, version: 2 }));
    await expect(prepareCompose(input, { acknowledge: async () => 2 })).rejects.toMatchObject({ accountMismatch: true });
  });
  it('reacknowledges only settings conflicts and refuses mismatched versions', async () => {
    const input = messagePreparation({ replyTo, mode: 'reply', accountId: 'one' });
    const acknowledge = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2);
    send.mockRejectedValueOnce(new Error('errors.settingsConflict')).mockImplementationOnce(async (_, p) => prepareDemoCompose(p, { accounts, values: {}, version: 2 }));
    expect((await prepareCompose(input, { acknowledge })).settingsVersion).toBe(2);
    send.mockImplementation(async (_, p) => ({ ...prepareDemoCompose(p, { accounts, values: {}, version: 2 }), settingsVersion: 3 }));
    await expect(prepareCompose(input, { acknowledge: async () => 2 })).rejects.toThrow('compose.preparationUnavailable');
  });
});

it('preserves every frozen supplemental large-input digest through the actual adapter and demo route', async () => {
  const { readFileSync } = await import('node:fs');
  const { createHash } = await import('node:crypto');
  const saved = JSON.parse(readFileSync('src-core/tests/fixtures/compose-prep-supplement.json', 'utf8'));
  const make = (spec, index = null) => {
    const tag = index === null ? 'original' : `context-${index}`;
    const words = `START-${tag}:` + spec.unit.repeat(index === null ? spec.originalRepeat : spec.contextRepeat) + `:END-${tag}`;
    return { from: { name: '<From & Name>', address: `${tag}@example.test` }, to: [{ address: 'owner@example.test' }], subject: `Subject <&> ${tag}`, date: `stamp-${tag}`, bcc: [{ address: 'bcc-large-sentinel@example.test' }],
      ...(spec.text ? { text: words } : { html: `<table style="color:red"><tr><td>${words}<img src="cid:logo"></td></tr></table>` }) };
  };
  send.mockImplementation(async (_, p) => prepareDemoCompose(p, { accounts, values: {}, version: 4 }));
  for (const { spec, digests } of saved.largeCases) {
    const replyTo = make(spec); replyTo._threadContext = Array.from({ length: spec.count }, (_, i) => make(spec, i));
    if (spec.selected !== undefined) replyTo._selectedQuoteHtml = spec.selected;
    const input = messagePreparation({ replyTo, mode: spec.mode, accountId: 'one' });
    input.presentation.originalLabel = 'Original message';
    const result = await prepareCompose(input, { acknowledge: async () => 4 });
    for (const [field, digest] of Object.entries(digests)) {
      expect({ bytes: Buffer.byteLength(result[field]), sha256: createHash('sha256').update(result[field]).digest('hex') }).toEqual(digest);
    }
  }
});
