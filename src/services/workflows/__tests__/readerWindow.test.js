// @vitest-environment jsdom

// A list row opens its message in a window through the reader that shows it:
// the reader owns the body scan, theme and renderer the window has to match.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useMailStore } from '../../../stores/mailStore';
import { emailScopeKey } from '../../../stores/slices/unifiedHelpers';
import { openEmailInWindow, registerReaderWindow } from '../readerWindow';

const email = (uid, extra = {}) => ({ uid, _accountId: 'acct-1', _mailbox: 'INBOX', source: 'server', ...extra });
const keyOf = e => emailScopeKey(e, useMailStore.getState());

let unregister = () => {};
afterEach(() => { unregister(); vi.useRealTimers(); });

describe('openEmailInWindow', () => {
  it('opens through the reader that already shows the message, without selecting again', async () => {
    const open = vi.fn();
    const select = vi.fn();
    const row = email(7);
    unregister = registerReaderWindow({ key: keyOf(row), open });
    expect(await openEmailInWindow(row, select)).toBe(true);
    expect(open).toHaveBeenCalledTimes(1);
    expect(select).not.toHaveBeenCalled();
  });

  it('selects a message the reader does not show, then opens it once the reader has it', async () => {
    const open = vi.fn();
    const row = email(8);
    const select = vi.fn(async () => {
      setTimeout(() => { unregister = registerReaderWindow({ key: keyOf(row), open }); }, 5);
    });
    expect(await openEmailInWindow(row, select)).toBe(true);
    expect(select).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('never opens another message than the one asked for', async () => {
    const open = vi.fn();
    unregister = registerReaderWindow({ key: keyOf(email(1)), open });
    expect(await openEmailInWindow(email(2), vi.fn(), 20)).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });

  it('gives up quietly when no reader ever shows it', async () => {
    expect(await openEmailInWindow(email(3), vi.fn(), 20)).toBe(false);
  });

  it('stops being offered once the reader unmounts', async () => {
    const open = vi.fn();
    const row = email(4);
    registerReaderWindow({ key: keyOf(row), open })();
    expect(await openEmailInWindow(row, vi.fn(), 20)).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });
});
