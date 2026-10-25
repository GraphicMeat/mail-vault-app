// Native-shaped accepted response for component tests that stub local IO.
export function savedDraftReply(request, uid = 1) {
  const identity = { accountId: request.accountId, mailbox: 'Drafts', uid, messageId: '<draft@test>', sha256: 'test-proof' };
  const entry = { uid, source: 'local_draft', flags: ['archived', 'draft', 'seen'] };
  return { draftId: request.draftId, revision: request.revision, disposition: 'saved',
    cleanup: 'complete', current: { identity, entry }, pending: null, cleanupIdentities: [], discarded: false,
    accountId: request.accountId, mailbox: 'Drafts', uid, entry: { ...entry, draftId: request.draftId, revision: request.revision } };
}
