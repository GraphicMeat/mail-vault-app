// @vitest-environment jsdom

// The delete confirmation every reader raises from its action bar: Delete opens
// the confirm, Cancel deletes nothing and closes it, Delete in the confirm
// deletes this message from its own account and folder. The reading pane and a
// thread hand focus back to the button that opened it; the chat bubble and the
// full view note no trigger, so focus is left where the dialog put it.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '../../services/workflows/bindStoreActions';

const { bodies } = vi.hoisted(() => ({ bodies: new Map() }));
vi.mock('@tanstack/react-virtual', () => ({ useVirtualizer: options => ({
  scrollToIndex: vi.fn(), measure: vi.fn(), measureElement: vi.fn(), getTotalSize: () => 300,
  getVirtualItems: () => Array.from({ length: options.count }, (_, index) => ({ index, key: options.getItemKey ? options.getItemKey(index) : index, start: index * 96 })),
}) }));
vi.mock('../../hooks/useChatBodyLoader', async () => {
  const { emailKey } = await import('../../stores/slices/unifiedHelpers');
  return { emailKey, useChatBodyLoader: () => ({ bodiesMapRef: { current: bodies }, registerListener: () => () => {} }) };
});
vi.mock('../../services/bodyScan', async (orig) => {
  const { stubBodyScan } = await import('../../test/bodyScan');
  return stubBodyScan(orig);
});
// The bar as QuickActions drives it: onActionStart with the trigger, then the action.
vi.mock('../email/EmailActionBar', () => ({ EmailActionBar: (p) => {
  const run = (action, handler) => (event) => { p.onActionStart?.(event, event.currentTarget, { action }); handler?.(p.email, { action }); };
  return (
    <div>
      <button data-testid="bar-delete" onClick={run('delete', p.onDelete)}>bar-delete</button>
      <button data-testid="bar-everywhere" onClick={run('deleteEverywhere', p.onDeleteEverywhere)}>bar-everywhere</button>
    </div>
  );
} }));

const { useMailStore } = await import('../../stores/mailStore');
const { useThemeStore } = await import('../../stores/themeStore');
const { useSettingsStore } = await import('../../stores/settingsStore');
const { emailKey } = await import('../../stores/slices/unifiedHelpers');
const { EmailViewer } = await import('../EmailViewer');
const { ChatBubbleView } = await import('../ChatBubbleView');
const { ThreadView } = await import('../email/ThreadView');
const { FullViewEmailModal } = await import('../email/FullViewEmailModal');

const mail = (uid) => ({
  uid, _accountId: 'acct-1', _mailbox: 'INBOX', source: 'server', subject: `S${uid}`, messageId: `<m${uid}@x>`,
  from: { name: 'Nell', address: 'nell@example.test' }, to: [{ address: 'me@example.test' }],
  html: `<p>Body ${uid}</p>`, text: `Body ${uid}`, attachments: [], flags: ['\\Seen'], date: '2026-10-01T10:00:00Z',
});

const READERS = {
  reader: { returnsFocus: true, show: () => {
    const email = mail(1);
    useMailStore.setState({ selectedEmail: email, selectedThread: null, emails: [email], sortedEmails: [email] });
    render(<EmailViewer />);
    return email;
  } },
  thread: { returnsFocus: true, show: () => {
    const email = mail(2);
    bodies.set(emailKey(email), { status: 'loaded', email });
    useMailStore.setState({ emails: [email], sortedEmails: [email] });
    render(<ThreadView thread={{ threadId: 't', subject: 'S2', emails: [email], messageCount: 1 }} />);
    return email;
  } },
  chat: { returnsFocus: false, show: () => {
    const email = mail(3);
    useMailStore.setState({ emails: [email], sortedEmails: [email] });
    render(<ChatBubbleView correspondent={{ name: 'Nell', email: 'nell@example.test' }}
      threadId="t" threadsMap={new Map([['t', { subject: 'S3', emails: [email] }]])}
      userEmail="me@example.test" onBack={() => {}} />);
    // The bubble shows its bar while hovered.
    fireEvent.mouseEnter(document.querySelector('[role="group"]').closest('.flex.gap-2'));
    return email;
  } },
  fullView: { returnsFocus: false, show: () => {
    const email = mail(4);
    useMailStore.setState({ emails: [email], sortedEmails: [email] });
    render(<FullViewEmailModal email={email} onClose={() => {}} />);
    return email;
  } },
};

const settle = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });
const nextFrame = () => act(async () => { await new Promise(r => requestAnimationFrame(() => r())); });
const openDelete = async () => {
  await settle();
  // Not focused first: a click does not focus a button in WebKit, so the
  // dialog's own restore has nothing to go back to.
  const opener = screen.getByTestId('bar-delete');
  await act(async () => { fireEvent.click(opener); });
  return opener;
};

let deleteEmailFromServer;
beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })));
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  useThemeStore.setState({ palette: 'graphite', theme: 'light' });
  useSettingsStore.setState({ emailViewerTheme: 'system', threadReaderLayout: 'timeline', signatureDisplay: 'smart', emailRenderer: 'web', confirmBeforeDelete: true });
  deleteEmailFromServer = vi.fn().mockResolvedValue(undefined);
  useMailStore.setState({
    accounts: [{ id: 'acct-1', email: 'me@example.test' }], activeAccountId: 'acct-1', activeMailbox: 'INBOX',
    mailboxScope: null, loadingEmail: false, selectedEmailSource: 'server', savedEmailIds: new Set(), archivedEmailIds: new Set(),
    deleteEmailFromServer,
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); bodies.clear(); });

describe.each(Object.keys(READERS))('%s delete confirmation', (name) => {
  const { show, returnsFocus } = READERS[name];

  it('Delete opens the confirm and deletes nothing yet', async () => {
    show();
    await openDelete();
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect(deleteEmailFromServer).not.toHaveBeenCalled();
  });

  it('Cancel closes the confirm and deletes nothing', async () => {
    show();
    const opener = await openDelete();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); });
    await nextFrame();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(deleteEmailFromServer).not.toHaveBeenCalled();
    if (returnsFocus) expect(document.activeElement).toBe(opener);
  });

  it('confirming deletes this message from its own account and folder', async () => {
    const email = show();
    const opener = await openDelete();
    const confirm = screen.getAllByRole('button', { name: /Delete/ }).filter(b => b.closest('[role="alertdialog"]'));
    await act(async () => { fireEvent.click(confirm.at(-1)); });
    await settle();
    await nextFrame();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await waitFor(() => expect(deleteEmailFromServer).toHaveBeenCalledTimes(1));
    const [uid, options] = deleteEmailFromServer.mock.calls[0];
    expect(uid).toBe(email.uid);
    expect(options).toMatchObject({ accountId: 'acct-1', mailboxOverride: 'INBOX' });
    if (returnsFocus) expect(document.activeElement).toBe(opener);
  });
});

describe('reading pane Delete everywhere', () => {
  it('raises its own confirm and hands focus back on Cancel', async () => {
    READERS.reader.show();
    await settle();
    const opener = screen.getByTestId('bar-everywhere');
    await act(async () => { fireEvent.click(opener); });
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); });
    await nextFrame();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});
