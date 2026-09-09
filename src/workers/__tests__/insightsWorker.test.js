import { describe, expect, it } from 'vitest';
import { A, COUNT_FIXTURE, copy } from '../../../tests/fixtures/insights.js';
import { buildInsightsModel, matchingInsightsMessages, queryInsights } from '../../utils/insights/model.js';
import { createInsightsWorkerHandler } from '../insightsWorker.js';

const options = { accounts: [{ id: A, email: 'me@example.test' }], ownAddressesByAccount: { [A]: ['me@example.test'] } };
const query = { accountIds: [A], startDate: '2026-09-01', endDate: '2026-09-09', timeZone: 'Europe/Vilnius',
  direction: 'both', senderAddress: null, hideAutomated: false, timelineBucket: 'week', senderSort: 'recent' };
function worker() {
  const replies = [];
  const handle = createInsightsWorkerHandler(reply => replies.push(reply));
  return { replies, send: data => handle({ data }) };
}
function build(target, copies = COUNT_FIXTURE, requestId = 'build-1') {
  target.send({ type: 'build', requestId, copies, ...options });
}

describe('Insights worker lifetime', () => {
  it('accepts staged build chunks of at most 1000 copies and commits each record exactly once', () => {
    const target = worker();
    const copies = COUNT_FIXTURE;
    target.send({ type: 'build-start', requestId: 'build-staged', ...options });
    for (let offset = 0; offset < copies.length; offset += 2) {
      target.send({ type: 'build-append', requestId: `chunk-${offset}`, buildId: 'build-staged', copies: copies.slice(offset, offset + 2) });
    }
    target.send({ type: 'build-commit', requestId: 'commit-staged', buildId: 'build-staged' });
    target.send({ type: 'query', requestId: 'query-staged', query });
    const chunkIds = Array.from({ length: Math.ceil(copies.length / 2) }, (_, index) => `chunk-${index * 2}`);
    expect(target.replies.map(reply => reply.requestId))
      .toEqual(['build-staged', ...chunkIds, 'commit-staged', 'query-staged']);
    expect(target.replies.find(reply => reply.requestId === 'build-staged')).toMatchObject({ type: 'build-started', payload: { buildId: 'build-staged' } });
    expect(target.replies.filter(reply => reply.type === 'build-appended')).toHaveLength(chunkIds.length);
    expect(target.replies.find(reply => reply.requestId === 'commit-staged')).toMatchObject({ type: 'built' });
    expect(target.replies.at(-1).payload.totals).toEqual({ received: 3, sent: 1, both: 4 });
  });

  it('does not publish a partial staged build before commit or after a malformed replacement', () => {
    const target = worker();
    build(target);
    target.send({ type: 'build-start', requestId: 'replacement', ...options });
    target.send({ type: 'build-append', requestId: 'replacement-chunk', buildId: 'replacement', copies: [copy({ uid: 77 })] });
    target.send({ type: 'query', requestId: 'before-commit', query });
    expect(target.replies.at(-1).payload.totals).toEqual({ received: 3, sent: 1, both: 4 });
    target.send({ type: 'build-append', requestId: 'bad-chunk', buildId: 'replacement', copies: [copy({ to: 42 })] });
    target.send({ type: 'build-commit', requestId: 'replacement-commit', buildId: 'replacement' });
    expect(target.replies.find(reply => reply.requestId === 'replacement-commit')).toMatchObject({ type: 'error', requestId: 'replacement-commit', payload: { code: 'build-failed' } });
    target.send({ type: 'query', requestId: 'after-failed', query });
    expect(target.replies.at(-1).payload.totals).toEqual({ received: 3, sent: 1, both: 4 });
    target.send({ type: 'build-start', requestId: 'replacement-2', ...options });
    target.send({ type: 'build-append', requestId: 'replacement-2-chunk', buildId: 'replacement-2', copies: [copy({ uid: 78 })] });
    target.send({ type: 'build-commit', requestId: 'replacement-2-commit', buildId: 'replacement-2' });
    target.send({ type: 'query', requestId: 'after-commit', query });
    expect(target.replies.at(-1).payload.totals.both).toBe(1);
  });

  it('rejects obsolete staged build IDs without disturbing the committed model', () => {
    const target = worker();
    build(target);
    target.send({ type: 'build-start', requestId: 'obsolete', ...options });
    target.send({ type: 'build-append', requestId: 'obsolete-chunk', buildId: 'obsolete', copies: COUNT_FIXTURE });
    target.send({ type: 'build-start', requestId: 'new', ...options });
    target.send({ type: 'build-append', requestId: 'new-chunk', buildId: 'new', copies: [copy({ uid: 77 })] });
    target.send({ type: 'build-append', requestId: 'late-append', buildId: 'obsolete', copies: [copy()] });
    target.send({ type: 'build-commit', requestId: 'late-commit', buildId: 'obsolete' });
    expect(target.replies.find(reply => reply.requestId === 'late-append')).toMatchObject({ type: 'error', requestId: 'late-append', payload: { code: 'obsolete-build' } });
    expect(target.replies.find(reply => reply.requestId === 'late-commit')).toMatchObject({ type: 'error', requestId: 'late-commit', payload: { code: 'obsolete-build' } });
    target.send({ type: 'query', requestId: 'before-new-commit', query });
    expect(target.replies.at(-1).payload.totals.both).toBe(4);
    target.send({ type: 'build-commit', requestId: 'new-commit', buildId: 'new' });
    expect(target.replies.find(reply => reply.requestId === 'new-commit')).toMatchObject({ type: 'built' });
    target.send({ type: 'query', requestId: 'still-good', query });
    expect(target.replies.at(-1).payload.totals.both).toBe(1);
  });

  it('builds a real model and returns the complete correlated query result', () => {
    const target = worker();
    build(target);
    target.send({ type: 'query', requestId: 'query-2', query });
    expect(target.replies).toHaveLength(2);
    expect(target.replies[0]).toEqual({ type: 'built', requestId: 'build-1', payload: null });
    expect(target.replies[1]).toEqual({ type: 'result', requestId: 'query-2', payload: queryInsights(buildInsightsModel(COUNT_FIXTURE, options), query) });
    expect(target.replies[1].payload.totals).toEqual({ received: 3, sent: 1, both: 4 });
  });

  it('forwards exact message selection and retains physical locators from the real model', () => {
    const target = worker();
    build(target);
    const selection = { senderAddress: 'ana@example.test', startDate: '2026-09-09', endDate: '2026-09-09' };
    target.send({ type: 'messages', requestId: 9, query, selection });
    expect(target.replies).toHaveLength(2);
    expect(target.replies[1]).toEqual({ type: 'messages', requestId: 9,
      payload: matchingInsightsMessages(buildInsightsModel(COUNT_FIXTURE, options), query, selection) });
    expect(target.replies[1].payload).toHaveLength(3);
    expect(target.replies[1].payload.find(row => row.copies[0].messageId === '<ana-1@test>').copies).toHaveLength(2);
  });

  it.each(['query', 'messages'])('reports %s before a build instead of returning an empty successful result', type => {
    const target = worker();
    target.send({ type, requestId: 'early', query });
    expect(target.replies).toHaveLength(1);
    expect(target.replies[0]).toMatchObject({ type: 'error', requestId: 'early', payload: { code: 'not-built' } });
    expect(target.replies[0].payload.message).toBeTruthy();
  });

  it('replaces a completed model on refresh instead of accumulating earlier inventory', () => {
    const target = worker();
    build(target);
    build(target, [copy({ uid: 77, messageId: '<replacement@test>' })], 'build-2');
    target.send({ type: 'query', requestId: 'latest', query });
    expect(target.replies).toHaveLength(3);
    expect(target.replies[2]).toMatchObject({ type: 'result', requestId: 'latest', payload: { totals: { received: 1, sent: 0, both: 1 } } });
  });

  it('isolates an invalid query error while preserving the built model and later requests', () => {
    const target = worker();
    build(target);
    target.send({ type: 'query', requestId: 'bad', query: { ...query, endDate: '2026-08-01' } });
    target.send({ type: 'query', requestId: 'good', query });
    expect(target.replies).toHaveLength(3);
    expect(target.replies[1]).toMatchObject({ type: 'error', requestId: 'bad', payload: { code: 'invalid-query' } });
    expect(target.replies[2]).toMatchObject({ type: 'result', requestId: 'good', payload: { totals: { both: 4 } } });
  });

  it('rejects unknown request types without corrupting subsequent work', () => {
    const target = worker();
    build(target);
    target.send({ type: 'delete-all-mail', requestId: 7 });
    target.send({ type: 'query', requestId: 8, query });
    expect(target.replies).toHaveLength(3);
    expect(target.replies[1]).toMatchObject({ type: 'error', requestId: 7, payload: { code: 'unknown-request' } });
    expect(target.replies[2].payload.totals.both).toBe(4);
  });

  it('keeps the previous model when replacement inventory cannot be normalized', () => {
    const target = worker();
    build(target);
    build(target, [copy({ to: 42 })], 'invalid-build');
    target.send({ type: 'query', requestId: 'still-good', query });
    expect(target.replies).toHaveLength(3);
    expect(target.replies[1]).toMatchObject({ type: 'error', requestId: 'invalid-build', payload: { code: 'build-failed' } });
    expect(target.replies[2].payload.totals.both).toBe(4);
  });

  it('keeps models separate for separate worker lifetimes', () => {
    const first = worker();
    const second = worker();
    build(first);
    build(second, [copy()]);
    first.send({ type: 'query', requestId: 1, query });
    second.send({ type: 'query', requestId: 1, query });
    expect(first.replies).toHaveLength(2);
    expect(second.replies).toHaveLength(2);
    expect(first.replies[1].payload.totals.both).toBe(4);
    expect(second.replies[1].payload.totals.both).toBe(1);
  });
});
