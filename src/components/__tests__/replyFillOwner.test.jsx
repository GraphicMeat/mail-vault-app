// @vitest-environment jsdom
import React, { Suspense, StrictMode, startTransition, useCallback, useLayoutEffect, useState } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('../../stores/safeStorage', async original => ({ ...(await original()), flushSafeStorage: async () => 0 }));
vi.mock('../../services/transport', () => ({ send: async (_method, params) => {
  const { prepareDemoCompose } = await import('../../demo/composePrep');
  return prepareDemoCompose(params, { accounts: [{ id: 'one', email: 'me@example.test' }], values: {}, version: 0 });
} }));
import { useReplyFillController } from '../../hooks/useReplyFillController';
const header = { uid: 8, _accountId: 'one', _mailbox: 'INBOX', from: { address: 'writer@example.test' }, subject: 'Replay', text: '' };
const full = { ...header, html: '<p>complete replay body</p>' };
const original = [{ id: 8, mode: 'reply', replyTo: header, minimized: true,
  snapshot: { to: 'authored@example.test', bcc: 'authored-bcc@example.test', body: '<p>typed</p>', _accountId: 'one', _fromAddress: 'me@example.test', _draftId: 'stable', _draftRevision: 4, _draftContent: { revision: 4, payload: { html: 'immutable bytes' } } } }];
const context = { mail: { accounts: [{ id: 'one', email: 'me@example.test' }], activeAccountId: 'one' }, settings: { getOrderedAccounts: accounts => accounts, aliases: {}, sendAsAddresses: {} } };
afterEach(cleanup);
it('keeps a real React owner fill pending while its render is suspended and acknowledges only after commit', async () => {
  let controller; let resolveGate; let blocked = true; let settled = false; const committed = [];
  const gate = new Promise(resolve => { resolveGate = resolve; });
  function Owner({ suspend }) {
    const [windows, setWindows] = useState(original);
    const transitioningSet = useCallback(update => startTransition(() => setWindows(update)), []);
    const current = useReplyFillController({ windows, setWindows: transitioningSet, getContext: () => context, onError: error => { throw error; } });
    useLayoutEffect(() => { controller = current; committed.push(windows); });
    if (suspend && blocked && windows[0].replyTo === full) throw gate;
    return <span data-testid="committed-reply">{windows[0].replyTo === full ? 'full' : 'header'}</span>;
  }
  const view = render(<StrictMode><Suspense fallback={<span>Waiting</span>}><Owner suspend /></Suspense></StrictMode>);
  let filling;
  await act(async () => {
    filling = controller.fill({ mode: 'reply', _fillFrom: header, replyTo: full });
    filling.then(() => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  expect(committed.at(-1)[0].replyTo === header).toBe(true);
  expect(settled).toBe(false);
  await act(async () => { blocked = false; resolveGate(); view.rerender(<StrictMode><Suspense fallback={<span>Waiting</span>}><Owner suspend={false} /></Suspense></StrictMode>); });
  await filling;
  await waitFor(() => expect(screen.getByTestId('committed-reply').textContent).toBe('full'));
  expect(committed.at(-1)[0].snapshot._quotedHtml).toContain('complete replay body');
  expect(committed.at(-1)[0].snapshot._draftContent).toBe(original[0].snapshot._draftContent);
});
