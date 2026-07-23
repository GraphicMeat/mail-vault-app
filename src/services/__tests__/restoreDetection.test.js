import { describe, it, expect, vi } from 'vitest';

// Mock the store/api dependencies so importing restoreDetection.js does not pull
// in the real store chain (which reads window.__TAURI__ at module-eval time and
// crashes under the node test environment). The pure heuristic needs none of it.
const mockCountLocalFolder = vi.fn();
vi.mock('../api.js', () => ({
  countLocalFolder: (...args) => mockCountLocalFolder(...args),
  checkMailboxStatus: vi.fn(),
}));
const mockGetMailboxes = vi.fn(() => []);
vi.mock('../../stores/accountStore.js', () => ({
  getMailboxes: (...args) => mockGetMailboxes(...args),
}));
vi.mock('../../stores/settingsStore.js', () => ({
  useSettingsStore: { getState: () => ({ setRestoreDetected: vi.fn() }) },
}));

const { shouldPromptRestore, gatherLocalFolders } = await import('../restoreDetection.js');

describe('shouldPromptRestore', () => {
  it('prompts when host changed and server is near-empty vs local', () => {
    expect(shouldPromptRestore({
      hostChanged: true, localTotal: 500, serverTotal: 0,
    })).toBe(true);
    expect(shouldPromptRestore({
      hostChanged: true, localTotal: 500, serverTotal: 10,
    })).toBe(true);
  });

  it('does not prompt without a host change', () => {
    expect(shouldPromptRestore({
      hostChanged: false, localTotal: 500, serverTotal: 0,
    })).toBe(false);
  });

  it('does not prompt for trivially small local mailboxes', () => {
    expect(shouldPromptRestore({
      hostChanged: true, localTotal: 5, serverTotal: 0,
    })).toBe(false);
  });

  it('does not prompt when the server already has the mail', () => {
    expect(shouldPromptRestore({
      hostChanged: true, localTotal: 500, serverTotal: 480,
    })).toBe(false);
  });
});

describe('gatherLocalFolders', () => {
  it('returns only folders with local mail, using the mailbox path/name/string as key', () => {
    mockGetMailboxes.mockReturnValueOnce([{ path: 'INBOX' }, { name: 'Archive' }, 'Sent']);
    mockCountLocalFolder.mockImplementation((accountId, mailbox) => {
      if (mailbox === 'INBOX') return Promise.resolve(10);
      if (mailbox === 'Archive') return Promise.resolve(0);
      if (mailbox === 'Sent') return Promise.resolve(3);
      return Promise.resolve(0);
    });

    return gatherLocalFolders({ id: 'acct-1' }).then((folders) => {
      expect(folders).toEqual([
        { mailbox: 'INBOX', localCount: 10 },
        { mailbox: 'Sent', localCount: 3 },
      ]);
    });
  });

  it('falls back to INBOX/Sent when there are no known mailboxes', () => {
    mockGetMailboxes.mockReturnValueOnce([]);
    mockCountLocalFolder.mockImplementation((accountId, mailbox) => Promise.resolve(mailbox === 'INBOX' ? 5 : 0));

    return gatherLocalFolders({ id: 'acct-1' }).then((folders) => {
      expect(folders).toEqual([{ mailbox: 'INBOX', localCount: 5 }]);
    });
  });

  it('treats a countLocalFolder rejection as 0 (folder omitted)', () => {
    mockGetMailboxes.mockReturnValueOnce(['INBOX']);
    mockCountLocalFolder.mockImplementation(() => Promise.reject(new Error('disk error')));

    return gatherLocalFolders({ id: 'acct-1' }).then((folders) => {
      expect(folders).toEqual([]);
    });
  });
});
