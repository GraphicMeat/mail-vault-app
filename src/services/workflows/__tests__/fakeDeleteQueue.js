// The daemon's delete queue (`delete_queue.submit`) for workflow tests that
// drive a delete through their per-message `api.deleteEmail` mock: each uid
// of the group is sent once through `sendOne(account, uid, mailbox)`, the
// shape the app used to call, and answered `landed` or, when it throws,
// `queued` (still owed). The daemon's own retries, journal and replay are
// pinned in src-daemon/src/delete_queue; this stands in for its answer only.
export async function fakeDeleteQueueSubmit(sendOne, { accountId, mailbox, uids }) {
  const { useMailStore } = await import('../../../stores/mailStore');
  const account = useMailStore.getState().accounts?.find(a => a.id === accountId) ?? { id: accountId };
  const landed = [];
  const queued = [];
  for (const uid of uids) {
    try {
      const res = await sendOne(account, uid, mailbox);
      landed.push({ kind: 'deleted', uid, trash: res?.trash ?? null, trashUid: res?.trashUid ?? null, binId: res?.binId ?? null });
    } catch {
      queued.push(uid);
    }
  }
  return { landed, queued, dropped: [] };
}
