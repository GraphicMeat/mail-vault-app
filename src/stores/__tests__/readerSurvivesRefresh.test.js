// A list reload for the view already on screen must not close the open
// message.
//
// Both list loaders wrote the reader's clear-set unconditionally:
// activateAccount (the Refresh button, the network retry, refreshCurrentView)
// and loadUnifiedInbox (the same button in All Inboxes). So a refresh landing
// while a message was open threw the message off the screen — reported as
// "a refresh of the list kicks in somewhere and closes the email".
//
// Navigation still clears it: the paths that really move set the new view's
// identity before they reload, so the comparison here sees a different view.
import { describe, it, expect } from 'vitest';
import { readerClearOnNavigation } from '../slices/unifiedHelpers';

const view = (accountId, mailbox) => ({ activeAccountId: accountId, activeMailbox: mailbox });

describe('readerClearOnNavigation', () => {
  it('clears nothing when the reload is for the view already on screen', () => {
    expect(readerClearOnNavigation(view('a', 'INBOX'), 'a', 'INBOX')).toEqual({});
  });

  it('closes the reader when the folder changes', () => {
    const update = readerClearOnNavigation(view('a', 'INBOX'), 'a', 'Sent');
    expect(update.selectedEmailId).toBeNull();
    expect(update.selectedEmail).toBeNull();
    expect(update.selectedEmailSource).toBeNull();
    expect(update.selectedThread).toBeNull();
    expect(update.selectedEmailIds).toEqual(new Set());
  });

  it('closes the reader when the account changes', () => {
    expect(readerClearOnNavigation(view('a', 'INBOX'), 'b', 'INBOX').selectedEmailId).toBeNull();
  });

  it('treats All Inboxes as its own view', () => {
    expect(readerClearOnNavigation(view('a', 'UNIFIED'), 'a', 'UNIFIED')).toEqual({});
    expect(readerClearOnNavigation(view('a', 'INBOX'), 'a', 'UNIFIED').selectedEmailId).toBeNull();
  });
});
