// @vitest-environment jsdom
// The phone's status line, the one issue row and the issues sheet (src/mobile/issues/), and the
// pull indicator that says nothing.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent, act, within } from '@testing-library/react';

const haptic = vi.hoisted(() => ({ selection: vi.fn(), impact: vi.fn(), notify: vi.fn() }));
vi.mock('../haptics.js', () => ({ haptic, watchSwitchHaptics: vi.fn(() => () => {}) }));

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };

const { StatusLine } = await import('../issues/StatusLine.jsx');
const { default: IssueRow } = await import('../issues/IssueRow.jsx');
const { default: IssuesSheet } = await import('../issues/IssuesSheet.jsx');
const { useAccountIssues } = await import('../issues/useAccountIssues.js');
const { PullIndicator } = await import('../MessageList.jsx');
const { Avatar } = await import('../AccountSwitcher.jsx');
const { t } = await import('../i18n.js');

beforeEach(() => {
  for (const f of Object.values(haptic)) f.mockClear();
  try { window.sessionStorage.clear(); } catch { /* none */ }
});
afterEach(cleanup);

const lapsed = { accountId: 'a1', email: 'ada@gmail.test', kind: 'signIn' };
const refused = { accountId: 'a3', email: 'cy@example.test', kind: 'refused' };
const lost = { accountId: 'a2', email: 'bo@example.test', kind: 'passwordLost' };

describe('StatusLine', () => {
  const now = Date.now();
  it('shows a spinner with "Checking mail" while one account syncs, the count with several', () => {
    const { container, rerender } = render(<StatusLine sync={{ state: 'syncing', at: now }} accountCount={1} />);
    expect(screen.getByText(t('mobile.status.checking'))).toBeTruthy();
    expect(container.querySelector('.mv-status-line__spinner')).toBeTruthy();
    rerender(<StatusLine sync={{ state: 'syncing', at: now }} accountCount={18} />);
    expect(screen.getByText(t('mobile.status.checkingMany', { accounts: 18 }))).toBeTruthy();
  });

  it('says when it last updated once idle, and nothing before any report', () => {
    const { container, rerender } = render(<StatusLine sync={{ state: 'idle', code: null, at: now }} accountCount={1} />);
    expect(screen.getByText(t('mobile.status.updatedNow'))).toBeTruthy();
    rerender(<StatusLine sync={{ state: 'idle', code: null, at: now - 7 * 60_000 }} accountCount={1} />);
    expect(screen.getByText(t('mobile.status.updatedMinutes', { minutes: 7 }))).toBeTruthy();
    rerender(<StatusLine sync={null} accountCount={1} />);
    expect(container.textContent).toBe('');
  });

  it('a failed update is one tap to retry, not a chip and a link', () => {
    const onRetry = vi.fn();
    render(<StatusLine sync={{ state: 'error', code: 'NETWORK', at: now }} accountCount={1} onRetry={onRetry} />);
    const retry = screen.getByRole('button', { name: t('mobile.status.failed') });
    fireEvent.click(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('the outbox count rides in the same line, alone when no sync has reported', () => {
    const { container, rerender } = render(<StatusLine sync={{ state: 'idle', code: null, at: now }} pending={2} accountCount={1} />);
    expect(container.textContent).toContain(t('mobile.status.updatedNow'));
    expect(container.textContent).toContain(t('mobile.actions.waiting', { count: 2 }));
    expect(container.querySelectorAll('[data-mv-status-line]').length).toBe(1);
    rerender(<StatusLine sync={null} pending={2} accountCount={1} />);
    expect(container.textContent).toBe(t('mobile.actions.waiting', { count: 2 }));
  });
});

describe('PullIndicator', () => {
  it('shows the spinner only: no pull, release or refreshing text, the label is for screen readers', () => {
    const ref = { current: document.createElement('div') };
    const { container, rerender } = render(<PullIndicator scrollRef={ref} onRefresh={() => {}} refreshing={false} />);
    expect(container.textContent).toBe('');
    rerender(<PullIndicator scrollRef={ref} onRefresh={() => {}} refreshing />);
    const status = container.querySelector('[role="status"]');
    expect(status.querySelector('.mv-pull__spinner')).toBeTruthy();
    const label = status.querySelector('.mv-visually-hidden');
    expect(label.textContent).toBe(t('mobile.list.refreshing'));
    expect(status.textContent).toBe(label.textContent);
  });
});

describe('IssueRow', () => {
  it('folds every account into one row: the count, Fix and a dismiss', () => {
    const onFix = vi.fn();
    const onDismiss = vi.fn();
    render(<IssueRow issues={[lapsed, refused]} onFix={onFix} onDismiss={onDismiss} />);
    expect(screen.getByText(t('mobile.issues.many', { accounts: 2 }))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t('mobile.issues.fix') }));
    expect(onFix).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: t('mobile.issues.dismiss') }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('one account names itself and what happened', () => {
    const { rerender } = render(<IssueRow issues={[lapsed]} onFix={() => {}} onDismiss={() => {}} />);
    expect(screen.getByText(t('mobile.issues.signInOne', { email: 'ada@gmail.test' }))).toBeTruthy();
    rerender(<IssueRow issues={[refused]} onFix={() => {}} onDismiss={() => {}} />);
    expect(screen.getByText(t('mobile.issues.refusedOne', { email: 'cy@example.test' }))).toBeTruthy();
    rerender(<IssueRow issues={[lost]} onFix={() => {}} onDismiss={() => {}} />);
    expect(screen.getByText(t('mobile.issues.passwordLostOne', { email: 'bo@example.test' }))).toBeTruthy();
  });

  it('renders nothing with no issue', () => {
    const { container } = render(<IssueRow issues={[]} onFix={() => {}} onDismiss={() => {}} />);
    expect(container.textContent).toBe('');
  });
});

describe('IssuesSheet', () => {
  const sheet = (props = {}) => render(
    <IssuesSheet
      issues={[lapsed, refused, lost]}
      accounts={[{ id: 'a1', email: 'ada@gmail.test' }, { id: 'a3', email: 'cy@example.test' }, { id: 'a2', email: 'bo@example.test' }]}
      reauthState={null}
      syncState={{}}
      onReauth={vi.fn()}
      onRetry={vi.fn(async () => ({ ok: true }))}
      onUpdatePassword={vi.fn()}
      onHide={vi.fn()}
      onClose={vi.fn()}
      {...props}
    />,
  );
  const rowOf = (email) => screen.getByText(email).closest('[data-mv-issue-account]');

  it('lists each account with what happened and the next step that fits it', () => {
    sheet();
    expect(screen.getByRole('dialog', { name: t('mobile.issues.many', { accounts: 3 }) })).toBeTruthy();
    const a = within(rowOf('ada@gmail.test'));
    expect(a.getByText(t('mobile.issues.signInWhat'))).toBeTruthy();
    expect(a.getByRole('button', { name: t('mobile.issues.signIn') })).toBeTruthy();
    const c = within(rowOf('cy@example.test'));
    expect(c.getByText(t('mobile.issues.refusedWhat'))).toBeTruthy();
    expect(c.getByRole('button', { name: t('mobile.refused.retry') })).toBeTruthy();
    expect(c.getByRole('button', { name: t('mobile.issues.updatePassword') })).toBeTruthy();
    const b = within(rowOf('bo@example.test'));
    expect(b.getByText(t('mobile.issues.passwordLostWhat'))).toBeTruthy();
    expect(b.queryByRole('button', { name: t('mobile.refused.retry') })).toBeNull();
    expect(b.getByRole('button', { name: t('mobile.issues.updatePassword') })).toBeTruthy();
  });

  it('Sign in runs the account\'s reauth, Update password opens the account, Hide hides', () => {
    const onReauth = vi.fn();
    const onUpdatePassword = vi.fn();
    const onHide = vi.fn();
    sheet({ onReauth, onUpdatePassword, onHide });
    fireEvent.click(within(rowOf('ada@gmail.test')).getByRole('button', { name: t('mobile.issues.signIn') }));
    expect(onReauth).toHaveBeenCalledWith('a1');
    fireEvent.click(within(rowOf('cy@example.test')).getByRole('button', { name: t('mobile.issues.updatePassword') }));
    expect(onUpdatePassword).toHaveBeenCalledWith('a3');
    fireEvent.click(screen.getByRole('button', { name: t('mobile.issues.hide') }));
    expect(onHide).toHaveBeenCalledTimes(1);
  });

  it('a sign-in in progress is busy, and its error stays on its account', () => {
    sheet({ reauthState: { accountId: 'a1', busy: true, code: null } });
    const btn = within(rowOf('ada@gmail.test')).getByRole('button', { name: t('mobile.add.signingIn') });
    expect(btn.disabled).toBe(true);
    cleanup();
    sheet({ reauthState: { accountId: 'a1', busy: false, code: 'AUTH_FAILED' } });
    expect(within(rowOf('ada@gmail.test')).getByRole('alert').textContent).toBe(t('mobile.error.AUTH_FAILED'));
    expect(within(rowOf('cy@example.test')).queryByRole('alert')).toBeNull();
  });

  it('Try again asks the engine once; a refusal that comes back after the pass is an error haptic', async () => {
    const onRetry = vi.fn(async () => ({ ok: true }));
    const view = sheet({ onRetry });
    await act(async () => { fireEvent.click(within(rowOf('cy@example.test')).getByRole('button', { name: t('mobile.refused.retry') })); });
    expect(onRetry).toHaveBeenCalledWith('a3');
    expect(haptic.notify).not.toHaveBeenCalled();
    // The pass ends refused again.
    view.rerender(
      <IssuesSheet issues={[lapsed, refused, lost]} accounts={[]} reauthState={null} syncState={{ a3: { state: 'error', code: 'AUTH_FAILED', at: Date.now() + 5 } }}
        onReauth={vi.fn()} onRetry={onRetry} onUpdatePassword={vi.fn()} onHide={vi.fn()} onClose={vi.fn()} />,
    );
    expect(haptic.notify).toHaveBeenCalledWith('error');
    expect(haptic.notify).toHaveBeenCalledTimes(1);
  });

  it('a Try again the engine itself refuses is an error haptic at once', async () => {
    sheet({ onRetry: vi.fn(async () => ({ ok: false, code: 'NETWORK' })) });
    await act(async () => { fireEvent.click(within(rowOf('cy@example.test')).getByRole('button', { name: t('mobile.refused.retry') })); });
    expect(haptic.notify).toHaveBeenCalledWith('error');
  });
});

describe('useAccountIssues', () => {
  const healthy = { id: 'a0', email: 'ok@example.test' };
  const parked = { id: 'a1', email: 'ada@gmail.test', needsAuth: true, oauth: true };
  const refusedAcct = { id: 'a3', email: 'cy@example.test', authRefused: true };
  let latest;
  function Probe({ accounts }) {
    latest = useAccountIssues(accounts);
    return null;
  }

  it('shows the row while there are issues, and a dismissal hides it until the set changes', () => {
    const { rerender } = render(<Probe accounts={[healthy]} />);
    expect(latest.issues).toEqual([]);
    expect(latest.shown).toBe(false);
    rerender(<Probe accounts={[healthy, parked]} />);
    expect(latest.shown).toBe(true);
    act(() => latest.dismiss());
    expect(latest.shown).toBe(false);
    // The same set keeps it hidden, a new issue brings it back.
    rerender(<Probe accounts={[healthy, { ...parked }]} />);
    expect(latest.shown).toBe(false);
    rerender(<Probe accounts={[healthy, parked, refusedAcct]} />);
    expect(latest.shown).toBe(true);
  });

  it('a dismissal outlives a remount in the same session, and clears once nothing is wrong', () => {
    const first = render(<Probe accounts={[parked]} />);
    act(() => latest.dismiss());
    first.unmount();
    const second = render(<Probe accounts={[parked]} />);
    expect(latest.shown).toBe(false);
    // Fixed, then broken again: it shows again.
    second.rerender(<Probe accounts={[healthy]} />);
    second.rerender(<Probe accounts={[parked]} />);
    expect(latest.shown).toBe(true);
  });
});

describe('Avatar warning dot', () => {
  it('an account with an issue wears a dot, a healthy one does not', () => {
    const { container, rerender } = render(<Avatar account={{ id: 'a1', email: 'ada@gmail.test' }} />);
    expect(container.querySelector('.mv-avatar__dot')).toBeNull();
    rerender(<Avatar account={{ id: 'a1', email: 'ada@gmail.test' }} issue />);
    expect(container.querySelector('.mv-avatar__dot')).toBeTruthy();
  });
});
