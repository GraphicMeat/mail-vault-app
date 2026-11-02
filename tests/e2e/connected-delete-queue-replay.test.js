/**
 * E2E: a delete still owed from a session that never sent it (offline, a
 * quit, a refusal) is finished by the daemon's replay worker, and the window
 * hears about it.
 *
 * The daemon's connectivity gate has no seam a spec can pin (window.__mvNet
 * pins only the app's own banner), and the mock's faults are fixed per run,
 * so "offline, then back online" is stood in for by what it leaves behind: a
 * delete entry in the journal, written the way the app's old journal wrote
 * one (no mode), and then the pass the worker runs when the link returns
 * (`delete_queue.run {reason: 'online'}`, the same pass its gate trigger
 * runs).
 *
 * The uid is one luke's INBOX does not hold, so no other spec's mail is
 * touched: the server answers the delete as done all the same, which is what
 * a replay of a delete that already went through sees.
 */

import assert from 'node:assert';
import { waitForApp, waitForEmails } from './helpers.js';

const LUKE_ID = '11111111-1111-4111-8111-111111111111';
const UID = 99_991;
const TOMBSTONE = `${LUKE_ID}|INBOX|${UID}`;

const rpc = (method, params = {}) => browser.executeAsync((m, p, done) => {
  window.__TAURI__.core.invoke('daemon_rpc', { method: m, params: p })
    .then(done)
    .catch((e) => done({ __error: String((e && e.message) || e) }));
}, method, params);

describe('Delete queue: a delete owed from an earlier session', function () {
  this.timeout(180_000);

  it('is replayed by the daemon, leaves the queue, and the window lifts its tombstone', async () => {
    await waitForApp();
    await waitForEmails();

    // Every queue event the window receives, from here on.
    await browser.executeAsync((done) => {
      window.__dqEvents = [];
      Promise.all(['delete-queue-landed', 'delete-queue-changed', 'delete-queue-status'].map((name) =>
        window.__TAURI__.event.listen(name, (e) => window.__dqEvents.push({ name, payload: e.payload }))))
        .then(() => done(true), () => done(false));
    });

    // What a session that went offline after the click left behind: the entry,
    // and the row hidden by its tombstone.
    const queued = await rpc('op_journal_queue', { entry: { id: 0, op: 'delete', accountId: LUKE_ID, mailbox: 'INBOX', uids: [UID], arg: {}, at: 0 } });
    assert.ok(!queued?.__error, `journal write failed: ${queued?.__error}`);
    await browser.execute((id) => {
      const store = window.__MAIL_STORE__;
      store.setState({ deleteTombstones: new Set([...store.getState().deleteTombstones, id]) });
    }, TOMBSTONE);

    const before = await rpc('delete_queue.list');
    assert.ok(Array.isArray(before), `list failed: ${JSON.stringify(before)}`);
    const owed = before.find((e) => e.accountId === LUKE_ID && e.uids.includes(UID));
    assert.ok(owed, `the entry is not in the queue: ${JSON.stringify(before)}`);
    assert.equal(owed.attempts, 0, 'nothing has tried it yet');

    // The link is back: the worker's pass.
    const counts = await rpc('delete_queue.run', { reason: 'online' });
    assert.ok(!counts?.__error, `run failed: ${counts?.__error}`);
    assert.equal(counts.done, 1, `the owed delete landed: ${JSON.stringify(counts)}`);
    assert.equal(counts.kept, 0, `nothing is owed after the pass: ${JSON.stringify(counts)}`);

    const after = await rpc('delete_queue.list');
    assert.ok(!after.some((e) => e.uids.includes(UID)), `still queued: ${JSON.stringify(after)}`);

    // The window heard it land, then the status of a non-manual pass.
    await browser.waitUntil(() => browser.execute((uid) =>
      (window.__dqEvents || []).some((e) => e.name === 'delete-queue-landed' && e.payload.landed.some((l) => l.uid === uid)), UID), {
      timeout: 10_000, timeoutMsg: 'delete-queue-landed never reached the window',
    });
    await browser.waitUntil(() => browser.execute(() =>
      (window.__dqEvents || []).some((e) => e.name === 'delete-queue-status' && e.payload.kept === 0)), {
      timeout: 10_000, timeoutMsg: 'delete-queue-status never reached the window',
    });

    // And the app's handler took the tombstone down: the daemon has the row.
    await browser.waitUntil(() => browser.execute((id) => !window.__MAIL_STORE__.getState().deleteTombstones.has(id), TOMBSTONE), {
      timeout: 10_000, timeoutMsg: 'the landed delete kept its tombstone',
    });
  });
});
