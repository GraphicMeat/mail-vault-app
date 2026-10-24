// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { create } from 'zustand';

vi.mock('../../i18n/index.js', () => ({
  t: key => key,
  useT: () => (key, vars) => (vars ? `${key}:${JSON.stringify(vars)}` : key),
}));

let store;
vi.mock('../../stores/viewStore', () => ({
  useViewStore: Object.assign(selector => store(selector), { getState: () => store.getState() }),
  viewLabel: (view, tr) => view?.name || (view?.builtin ? tr(`views.builtin.${view.builtin}`) : ''),
  viewQueryIsEmpty: view => !(view?.def?.query || '').trim(),
  MAX_FREE_VIEWS: 3,
}));
vi.mock('../../stores/settingsStore', () => ({
  useSettingsStore: selector => selector({ billingProfile: null, searchIndexAttachments: false }),
  hasPremiumAccess: () => false,
}));

const { ViewBuilderPanel } = await import('../email/ViewBuilderPanel');

const BILL = { uid: 7, messageId: '<bill@servico.lt>', _accountId: 'acct-1', _mailbox: 'INBOX', subject: 'Saskaita', from: { name: 'Servico, UAB', address: 'Bills@Servico.lt' } };
const UTILITIES = { id: 'v-util', name: 'Utilities', def: { query: 'saskaita', senders: ['servico.lt'] } };
const WHO = [
  { address: 'bills@servico.lt', name: 'Servico, UAB', count: 9, own: false },
  { address: 'me@x.test', name: 'Me', count: 4, own: true },
  { address: 'news@shop.test', name: 'Shop', count: 2, own: false },
];

const make = (overrides = {}) => {
  store = create(() => ({
    views: [UTILITIES],
    loadKeywords: vi.fn(async () => ({ available: true, keywords: [{ term: 'saskaita', tf: 3, df: 4 }] })),
    loadKeywordDetail: vi.fn(async () => ({ available: true, total: 0, senders: [], subjects: [] })),
    loadViewSenders: vi.fn(async () => ({ available: true, senders: WHO })),
    addTermsToView: vi.fn(async () => ({ ok: true, wasEmpty: false })),
    addSendersToView: vi.fn(async () => ({ ok: true })),
    blockSendersInView: vi.fn(async () => ({ ok: true })),
    removeSendersFromView: vi.fn(async () => ({ ok: true })),
    keepMessageOutOfView: vi.fn(async () => ({ ok: true })),
    createViewFromTerms: vi.fn(async () => ({ ok: true, view: { id: 'new' } })),
    ...overrides,
  }));
};

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
const renderPanel = async (props = {}) => {
  render(<ViewBuilderPanel email={BILL} accountId="acct-1" mailbox="INBOX" onClose={() => {}} {...props} />);
  await flush();
};
const click = async id => { await act(async () => { fireEvent.click(screen.getByTestId(id)); }); };

beforeEach(() => make());
afterEach(cleanup);

describe('the builder offers the sender', () => {
  it('as an address chip and a domain chip, unchecked', async () => {
    await renderPanel();
    const boxes = within(screen.getByTestId('view-builder-senders')).getAllByRole('checkbox');
    expect(boxes.map(box => box.textContent)).toEqual(['bills@servico.lt', 'servico.lt']);
    for (const box of boxes) expect(box.getAttribute('aria-checked')).toBe('false');
  });

  it('only the address for a mail provider, and nothing for a row with no sender', async () => {
    await renderPanel({ email: { ...BILL, from: { address: 'someone@gmail.com' } } });
    expect(within(screen.getByTestId('view-builder-senders')).getAllByRole('checkbox').map(box => box.textContent)).toEqual(['someone@gmail.com']);
    cleanup();
    await renderPanel({ email: { ...BILL, from: undefined } });
    expect(screen.queryByTestId('view-builder-senders')).toBeNull();
  });

  it('a sender alone is enough to make a view, which carries it', async () => {
    await renderPanel();
    expect(screen.getByTestId('view-builder-new').disabled).toBe(true);
    fireEvent.click(screen.getByTestId('view-builder-sender-1'));
    expect(screen.getByTestId('view-builder-new').disabled).toBe(false);
    await click('view-builder-new');
    expect(store.getState().createViewFromTerms).toHaveBeenCalledWith([], { accountId: 'acct-1', mailbox: null, senders: ['servico.lt'] }, false);
  });

  it('words and senders go into the view together, with no empty-query warning for senders alone', async () => {
    await renderPanel();
    fireEvent.click(screen.getByTestId('view-builder-sender-0'));
    await click('view-builder-add');
    expect(store.getState().addSendersToView).toHaveBeenCalledWith('v-util', ['bills@servico.lt']);
    expect(store.getState().addTermsToView).not.toHaveBeenCalled();
    expect(screen.queryByTestId('view-builder-empty-warning')).toBeNull();
    fireEvent.click(screen.getAllByRole('checkbox').find(el => el.textContent.includes('saskaita')));
    await click('view-builder-add');
    expect(store.getState().addTermsToView).toHaveBeenCalledWith('v-util', ['saskaita']);
    expect(store.getState().addSendersToView).toHaveBeenCalledTimes(1);
  });
});

describe('keeping mail out of a view', () => {
  it('keeps this one message out of the chosen view', async () => {
    await renderPanel();
    await click('view-builder-keep-out');
    expect(store.getState().keepMessageOutOfView).toHaveBeenCalledWith('v-util', BILL);
    expect(screen.getByRole('status').textContent).toContain('viewBuilder.keptOut');
  });

  it('blocks the sender, address first, in the chosen view', async () => {
    await renderPanel();
    await click('view-builder-block-sender');
    expect(store.getState().blockSendersInView).toHaveBeenCalledWith('v-util', ['bills@servico.lt']);
    expect(screen.getByRole('status').textContent).toContain('viewBuilder.blocked');
  });

  it('says so when the save failed', async () => {
    make({ keepMessageOutOfView: vi.fn(async () => ({ ok: false, reason: 'unkeyed' })) });
    await renderPanel();
    await click('view-builder-keep-out');
    expect(screen.getByRole('status').textContent).toContain('viewBuilder.saveFailed');
  });

  it('offers neither without a view to keep it out of', async () => {
    make({ views: [] });
    await renderPanel();
    expect(screen.queryByTestId('view-builder-keep-out')).toBeNull();
    expect(screen.queryByTestId('view-builder-block-sender')).toBeNull();
  });
});

describe('who sends what the view finds', () => {
  const open = async () => { await click('view-builder-show-senders'); await flush(); };

  it('loads nothing until asked, then lists the senders with their standing and count', async () => {
    await renderPanel();
    expect(store.getState().loadViewSenders).not.toHaveBeenCalled();
    await open();
    expect(store.getState().loadViewSenders).toHaveBeenCalledWith(UTILITIES.def);
    expect(within(screen.getByTestId('view-builder-who-0')).getByText('viewBuilder.state.allowed')).toBeTruthy();
    expect(within(screen.getByTestId('view-builder-who-1')).getByText('viewBuilder.state.outside')).toBeTruthy();
    expect(screen.getByTestId('view-builder-who-1').textContent).toContain('viewBuilder.you');
    expect(screen.getByTestId('view-builder-who-2').textContent).toContain('2');
  });

  it('blocks, allows and forgets one sender from its row', async () => {
    await renderPanel();
    await open();
    await click('view-builder-who-2-block');
    expect(store.getState().blockSendersInView).toHaveBeenCalledWith('v-util', ['news@shop.test']);
    await click('view-builder-who-1-allow');
    expect(store.getState().addSendersToView).toHaveBeenCalledWith('v-util', ['me@x.test']);
    await click('view-builder-who-0-clear');
    expect(store.getState().removeSendersFromView).toHaveBeenCalledWith('v-util', ['bills@servico.lt']);
  });

  it('suggests hiding the mail the account sent, from the first row it owns', async () => {
    await renderPanel();
    await open();
    await click('view-builder-hide-mine');
    expect(store.getState().blockSendersInView).toHaveBeenCalledWith('v-util', ['me@x.test']);
  });

  it('reads the list again once the view changes under it', async () => {
    await renderPanel();
    await open();
    act(() => { store.setState({ views: [{ ...UTILITIES, def: { ...UTILITIES.def, excludeSenders: ['news@shop.test'] } }] }); });
    await flush();
    expect(store.getState().loadViewSenders).toHaveBeenCalledTimes(2);
  });

  it('says so when the index cannot answer', async () => {
    make({ loadViewSenders: vi.fn(async () => ({ available: false, senders: [] })) });
    await renderPanel();
    await open();
    expect(screen.getByTestId('view-builder-who-state').textContent).toContain('viewBuilder.sendersUnavailable');
  });
});
