import { describe, it, expect } from 'vitest';
import { resolveErrorToastProps } from '../errorToast';

describe('resolveErrorToastProps', () => {
  it('renders warning/8s when errorTypeFor names the current error', () => {
    const state = { error: 'oops, caveat', errorType: 'warning', errorTypeFor: 'oops, caveat' };
    expect(resolveErrorToastProps(state)).toEqual({ type: 'warning', duration: 8000 });
  });

  it('renders error/5s by default (no errorType set)', () => {
    const state = { error: 'plain failure', errorType: 'error', errorTypeFor: null };
    expect(resolveErrorToastProps(state)).toEqual({ type: 'error', duration: 5000 });
  });

  // The scenario the whole errorTypeFor indirection exists for: a warning
  // toast is showing (delete_everywhere's queuedBackup/failed/needsResync
  // outcome), then some unrelated workflow fires a genuine failure the way
  // every existing call site does it — a raw `setState({ error: '...' })`
  // with no errorType/errorTypeFor of its own. The new message must render
  // red, not inherit the still-unwatched warning's styling.
  it('falls back to error/5s when a later plain error overwrites a warning without updating errorTypeFor', () => {
    // Warning toast currently showing (e.g. EmailList's delete_everywhere outcome).
    let state = { error: 'some backup copies queued', errorType: 'warning', errorTypeFor: 'some backup copies queued' };
    expect(resolveErrorToastProps(state)).toEqual({ type: 'warning', duration: 8000 });

    // A workflow file overwrites `error` the way messageMutations.js /
    // loadEmails.js / activateAccount.js / selectEmail.js actually do it —
    // setting only `error`, untouched errorType/errorTypeFor carried over.
    state = { ...state, error: 'Failed to archive email: network error' };
    expect(resolveErrorToastProps(state)).toEqual({ type: 'error', duration: 5000 });
  });

  it('falls back to error/5s when errorTypeFor is null (initial state)', () => {
    expect(resolveErrorToastProps({ error: null, errorType: 'error', errorTypeFor: null })).toEqual({ type: 'error', duration: 5000 });
  });
});
