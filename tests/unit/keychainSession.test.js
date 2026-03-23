import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as session from '../../src/services/keychainSession.js';

describe('keychainSession — state machine', () => {
  beforeEach(() => {
    // Reset to idle for each test
    session.resetForRetry();
    // resetForRetry keeps _promptShown — force full reset via recordOutcome
    // Actually, just test from the current state
  });

  it('starts in idle state', () => {
    session.resetForRetry();
    expect(session.getStatus()).toBe('idle');
    expect(session.getMessage()).toBeNull();
    expect(session.isLockedOut()).toBe(false);
    expect(session.isGranted()).toBe(false);
  });

  it('records granted outcome', () => {
    session.recordOutcome('granted');
    expect(session.getStatus()).toBe('granted');
    expect(session.isGranted()).toBe(true);
    expect(session.isLockedOut()).toBe(false);
    expect(session.hasPromptedThisSession()).toBe(true);
  });

  it('records denied outcome and locks out', () => {
    session.recordOutcome('denied', 'User clicked deny');
    expect(session.getStatus()).toBe('denied');
    expect(session.getMessage()).toBe('User clicked deny');
    expect(session.isLockedOut()).toBe(true);
    expect(session.isGranted()).toBe(false);
  });

  it('records cancelled outcome and locks out', () => {
    session.recordOutcome('cancelled');
    expect(session.isLockedOut()).toBe(true);
  });

  it('records timed_out outcome and locks out', () => {
    session.recordOutcome('timed_out');
    expect(session.isLockedOut()).toBe(true);
  });

  it('records empty outcome without locking out', () => {
    session.recordOutcome('empty');
    expect(session.getStatus()).toBe('empty');
    expect(session.isLockedOut()).toBe(false);
    expect(session.isGranted()).toBe(false);
  });

  it('records unavailable outcome without locking out', () => {
    session.recordOutcome('unavailable', 'D-Bus down');
    expect(session.getStatus()).toBe('unavailable');
    expect(session.getMessage()).toBe('D-Bus down');
    // unavailable is not a user-initiated denial, don't lock out
    expect(session.isLockedOut()).toBe(false);
  });

  it('resetForRetry clears lockout and allows new prompt', () => {
    session.recordOutcome('denied');
    expect(session.isLockedOut()).toBe(true);

    session.resetForRetry();
    expect(session.getStatus()).toBe('idle');
    expect(session.isLockedOut()).toBe(false);
    // promptShown stays true — we track that a prompt was shown
    expect(session.hasPromptedThisSession()).toBe(true);
  });
});

describe('keychainSession — listeners', () => {
  beforeEach(() => {
    session.resetForRetry();
  });

  it('notifies subscribers on status change', () => {
    const listener = vi.fn();
    const unsub = session.subscribe(listener);

    session.recordOutcome('granted');
    expect(listener).toHaveBeenCalledWith('granted', null);

    session.recordOutcome('denied', 'No access');
    expect(listener).toHaveBeenCalledWith('denied', 'No access');

    unsub();

    session.recordOutcome('empty');
    expect(listener).toHaveBeenCalledTimes(2); // not called after unsub
  });
});

describe('keychainSession — concurrent access protection', () => {
  beforeEach(() => {
    session.resetForRetry();
  });

  it('lockout prevents repeated prompts', () => {
    session.recordOutcome('denied');

    // Attempting another read should see lockout
    expect(session.isLockedOut()).toBe(true);
    // This is what loadKeychain checks before invoking get_credentials
  });

  it('explicit retry clears lockout for one new attempt', () => {
    session.recordOutcome('timed_out');
    expect(session.isLockedOut()).toBe(true);

    session.resetForRetry();
    expect(session.isLockedOut()).toBe(false);
    expect(session.getStatus()).toBe('idle');

    // After retry resolves, lockout may be set again
    session.recordOutcome('timed_out');
    expect(session.isLockedOut()).toBe(true);
  });
});
