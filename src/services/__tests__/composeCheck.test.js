// @vitest-environment jsdom
import { beforeEach, it, expect, vi } from 'vitest';
const { send, flush } = vi.hoisted(() => ({ send: vi.fn(), flush: vi.fn() }));
vi.mock('../transport', () => ({ send }));
vi.mock('../../stores/safeStorage', () => ({ flushSafeStorage: flush }));
import * as prep from '../composePrep';
import { htmlToText } from '../../components/RichTextEditor';
const input = () => ({ draftId: 'draft-issued', revision: 9, accountId: 'one', fromAddress: 'me@example.test', mode: 'new', forward: false, to: 'friend@example.test', cc: '', bcc: 'private@example.test', subject: '', authoredBodyText: 'body', attachmentCount: 0, sendPlan: null, scheduleDraft: null, timeZone: 'UTC', sendAnyway: false });
const ready = p => ({ requestId: p.requestId, settingsVersion: p.expectedSettingsVersion, ...(p.draftId !== undefined && { draftId: p.draftId }), ...(p.revision !== undefined && { revision: p.revision }), kind: 'ready', route: { delay: null } });
beforeEach(() => { vi.resetAllMocks(); flush.mockResolvedValue(4); send.mockImplementation(async (_, p) => ready(p)); });
it('projects full actual authored text and supported schedule fields without private send data', async () => {
  expect(prep.checkCompose).toBeTypeOf('function');
  const authoredBodyText = htmlToText(`<p>${'界\\"'.repeat(400000)} attached</p>`);
  expect(authoredBodyText).toBe('界\\"'.repeat(400000) + ' attached');
  expect(new TextEncoder().encode(authoredBodyText).length).toBe(2000009);
  const p = { ...input(), authoredBodyText, body: '<p>private body</p>', attachments: [{ bytes: 'private' }], account: { password: 'secret' }, requestId: 'caller-id', expectedSettingsVersion: 99, sendPlan: { kind: 'at', presentation: true }, scheduleDraft: { localTime: '2030-01-01T09:00', tz: 'Europe/Vilnius', tzPicked: true } };
  await prep.checkCompose(p);
  const [method, wire] = send.mock.calls[0];
  expect(method).toBe('compose.check'); expect(wire.authoredBodyText).toBe(authoredBodyText); expect(wire.authoredBodyText.endsWith(' attached')).toBe(true);
  expect(new TextEncoder().encode(JSON.stringify(wire)).length).toBeGreaterThan(2 * 1024 * 1024);
  expect(wire).toEqual({ ...input(), authoredBodyText, sendPlan: { kind: 'at' }, scheduleDraft: { localTime: '2030-01-01T09:00', tz: 'Europe/Vilnius' }, requestId: expect.any(String), expectedSettingsVersion: 4 });
  expect(wire.requestId).not.toBe('caller-id'); expect(flush).toHaveBeenCalledWith({ acknowledge: true, purpose: 'send-check' });
});
it('ordinary check retries one acknowledged conflict while final version mode never acknowledges or upgrades', async () => {
  expect(prep.checkCompose).toBeTypeOf('function');
  flush.mockResolvedValueOnce(4).mockResolvedValueOnce(5);
  send.mockRejectedValueOnce(new Error('errors.settingsConflict'));
  expect((await prep.checkCompose(input())).settingsVersion).toBe(5); expect(flush).toHaveBeenCalledTimes(2);
  flush.mockClear(); send.mockRejectedValueOnce(new Error('errors.settingsConflict'));
  await expect(prep.checkCompose(input(), { settingsVersion: 5 })).rejects.toThrow('errors.settingsConflict');
  expect(flush).not.toHaveBeenCalled();
  expect((await prep.checkCompose(input(), { settingsVersion: 5 })).settingsVersion).toBe(5);
});
it('freezes before ACK and refuses stale results, malformed versions and ordinary timeouts without retry', async () => {
  expect(prep.checkCompose).toBeTypeOf('function');
  const p = input(); const acknowledge = async () => { p.to = 'changed@example.test'; return 4; };
  await prep.checkCompose(p, { acknowledge }); expect(send.mock.calls[0][1].to).toBe('friend@example.test');
  send.mockClear(); await expect(prep.checkCompose(input(), { acknowledge: async () => 4, isCurrent: () => false })).rejects.toThrow('compose.preparationUnavailable'); expect(send).not.toHaveBeenCalled();
  for (const settingsVersion of [undefined, null, '4', -1, 1.2, NaN]) await expect(prep.checkCompose(input(), { settingsVersion })).rejects.toThrow('compose.preparationUnavailable');
  let current = true; send.mockImplementation(async (_, p) => { current = false; return ready(p); });
  await expect(prep.checkCompose(input(), { isCurrent: () => current })).rejects.toThrow('compose.preparationUnavailable');
  send.mockReset().mockRejectedValue(new Error('timeout')); flush.mockClear();
  await expect(prep.checkCompose(input())).rejects.toThrow('timeout'); expect(send).toHaveBeenCalledTimes(1); expect(flush).toHaveBeenCalledTimes(1);
});
it.each([
  p => ({ ...ready(p), requestId: 'wrong' }), p => ({ ...ready(p), settingsVersion: 7 }), p => ({ ...ready(p), draftId: 'other' }), p => ({ ...ready(p), revision: 8 }),
  p => ({ ...ready(p), kind: 'unknown' }), p => ({ ...ready(p), route: {} }), p => ({ ...ready(p), route: { delay: null, draft: { localTime: '2030-01-01T09:00', tz: 'UTC' } } }),
  p => ({ ...ready(p), route: { delay: -1 } }), p => ({ ...ready(p), route: { delay: 1.5 } }), p => ({ ...ready(p), route: { draft: { localTime: 1, tz: 'UTC' } } }),
  p => ({ ...ready(p), key: 'compose.noAccountSelected' }), p => ({ ...ready(p), kind: 'confirm_attachment' }),
  p => ({ ...ready(p), kind: 'invalid', key: 'anything', route: undefined }), p => ({ ...ready(p), kind: 'invalid', key: 'compose.invalidRecipient', route: undefined }),
])('refuses malformed or mismatched readiness %#', async malformed => {
  expect(prep.checkCompose).toBeTypeOf('function'); send.mockImplementation(async (_, p) => malformed(p));
  await expect(prep.checkCompose(input())).rejects.toThrow('compose.preparationUnavailable');
});
it('accepts only exact native invalid/confirm/route unions including absent optional draft identity', async () => {
  expect(prep.checkCompose).toBeTypeOf('function');
  for (const outcome of [{ kind: 'invalid', key: 'compose.pleaseEnterLeastOneRecipient' }, { kind: 'invalid', key: 'compose.invalidRecipient', args: { address: 'bad' } }, { kind: 'invalid', key: 'compose.noAccountSelected' }, { kind: 'invalid', key: 'scheduled.picker.pastTime' }, { kind: 'confirm_attachment' }, { kind: 'ready', route: { delay: 300 } }, { kind: 'ready', route: { draft: { localTime: '2030-01-01T09:00', tz: 'UTC' } } }]) {
    send.mockImplementation(async (_, p) => { const { route, ...base } = ready(p); return { ...base, ...outcome }; });
    expect(await prep.checkCompose(input())).toMatchObject(outcome);
  }
  const p = input(); delete p.draftId; delete p.revision;
  send.mockImplementation(async (_, p) => ready(p)); expect(await prep.checkCompose(p)).not.toHaveProperty('draftId');
  send.mockImplementation(async (_, p) => ({ ...ready(p), revision: 0 })); await expect(prep.checkCompose(p)).rejects.toThrow('compose.preparationUnavailable');
});

it.each([
  ['2030-02-31T09:00', 'UTC'], ['2030-04-31T09:00', 'UTC'],
  ['2030-02-29T09:00', 'UTC'], ['1900-02-29T09:00', 'UTC'], ['2100-02-29T09:00', 'UTC'],
  ['2030-00-01T09:00', 'UTC'], ['2030-13-01T09:00', 'UTC'], ['2030-01-00T09:00', 'UTC'], ['2030-01-32T09:00', 'UTC'],
  ['2030-01-01T24:00', 'UTC'], ['2030-01-01T99:00', 'UTC'], ['2030-01-01T09:60', 'UTC'], ['2030-01-01T09:99', 'UTC'],
  ['2030-01-01T09:00', 'not-a-zone'], ['2030-01-01T09:00', 'Europe/Not_A_City'], ['2030-01-01T09:00', ' UTC '],
])('refuses matching ready envelopes with invalid wall time or zone %s %s', async (localTime, tz) => {
  send.mockImplementation(async (_, p) => ({ ...ready(p), route: { draft: { localTime, tz } } }));
  await expect(prep.checkCompose(input())).rejects.toThrow('compose.preparationUnavailable');
});
it.each([
  ['2000-02-29T09:00', 'UTC'], ['2024-02-29T23:59', 'UTC'], ['2400-02-29T00:00', 'UTC'],
  ['0000-02-29T09:00', 'UTC'], ['0100-02-28T09:00', 'UTC'], ['9999-12-31T23:59', 'UTC'],
  ['2026-03-29T03:30', 'Europe/Vilnius'], ['2026-10-25T03:30', 'Europe/Vilnius'],
  ['2026-03-08T02:30', 'America/New_York'], ['2026-11-01T01:30', 'America/New_York'],
  ['2030-01-01T09:00', 'Asia/Kathmandu'], ['2030-01-01T09:00', 'Pacific/Chatham'],
  ['2030-01-01T09:00', 'Etc/GMT+5'], ['2030-01-01T09:00', 'US/Eastern'], ['2030-01-01T09:00', 'Etc/UTC'],
])('preserves valid Gregorian wall times, DST gaps/folds and supported zone aliases %s %s', async (localTime, tz) => {
  const draft = { localTime, tz };
  send.mockImplementation(async (_, p) => ({ ...ready(p), route: { draft } }));
  const result = await prep.checkCompose(input());
  expect(result.route).toEqual({ draft });
});
