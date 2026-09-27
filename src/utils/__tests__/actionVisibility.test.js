import { describe, expect, it } from 'vitest';
import { actionVisibility } from '../actionVisibility';

const email = (overrides = {}) => ({ flags: [], isArchived: false, ...overrides });

describe('actionVisibility', () => {
  it('shows mark read only, on an all-unread target', () => {
    const v = actionVisibility([email(), email()]);
    expect(v.markRead).toBe(true);
    expect(v.markUnread).toBe(false);
  });

  it('shows mark unread only, on an all-read target', () => {
    const v = actionVisibility([email({ flags: ['\\Seen'] }), email({ flags: ['\\Seen'] })]);
    expect(v.markRead).toBe(false);
    expect(v.markUnread).toBe(true);
  });

  it('shows both mark read and mark unread on a mixed target', () => {
    const v = actionVisibility([email(), email({ flags: ['\\Seen'] })]);
    expect(v.markRead).toBe(true);
    expect(v.markUnread).toBe(true);
  });

  it('shows unstar only, on an all-flagged target', () => {
    const v = actionVisibility([email({ flags: ['\\Flagged'] }), email({ flags: ['\\Flagged'] })]);
    expect(v.star).toBe(false);
    expect(v.unstar).toBe(true);
  });

  it('shows both star and unstar on a mixed-flag target', () => {
    const v = actionVisibility([email(), email({ flags: ['\\Flagged'] })]);
    expect(v.star).toBe(true);
    expect(v.unstar).toBe(true);
  });

  it('shows archive only while a target is unarchived, and unarchive once it is archived', () => {
    expect(actionVisibility([email({ isArchived: false })])).toMatchObject({ archive: true, unarchive: false });
    expect(actionVisibility([email({ isArchived: true })])).toMatchObject({ archive: false, unarchive: true });
    expect(actionVisibility([email({ isArchived: false }), email({ isArchived: true })]))
      .toMatchObject({ archive: true, unarchive: true });
  });

  it('shows nothing for an empty target', () => {
    expect(actionVisibility([])).toEqual({
      markRead: false, markUnread: false, star: false, unstar: false, archive: false, unarchive: false,
    });
  });
});
