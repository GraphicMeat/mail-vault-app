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
let premiumPlan = false;
vi.mock('../../stores/viewStore', () => ({
  useViewStore: Object.assign(selector => store(selector), { getState: () => store.getState() }),
  viewLabel: (view, tr) => view?.name || (view?.builtin ? tr(`views.builtin.${view.builtin}`) : ''),
  viewQueryIsEmpty: view => !(view?.def?.query || '').trim(),
  MAX_FREE_VIEWS: 3,
}));
let settings = { searchIndexAttachments: true };
vi.mock('../../stores/settingsStore', () => ({
  useSettingsStore: selector => selector({ billingProfile: null, ...settings }),
  hasPremiumAccess: () => premiumPlan,
}));

const { ViewBuilderPanel } = await import('../email/ViewBuilderPanel');

const EMAIL = { uid: 7, _accountId: 'acct-1', _mailbox: 'INBOX', subject: 'Fondue night' };
const VIEWS = [
  { id: 'v-full', name: 'Food', def: { query: 'cheese' } },
  { id: 'v-empty', name: 'Starred mail', def: { query: '', starred: true } },
];
const KEYWORDS = [{ term: 'fondue', tf: 3, df: 4 }, { term: 'gruyere', tf: 2, df: 2 }, { term: 'caquelon', tf: 1, df: 1 }];
const senders = n => Array.from({ length: n }, (_, i) => ({ name: `Sender ${i}`, address: `s${i}@x.test`, count: n - i }));
const subjects = n => Array.from({ length: n }, (_, i) => ({ subject: `Subject ${i}`, sender: `Sender ${i}`, count: n - i }));

const make = (overrides = {}) => {
  store = create(() => ({
    views: VIEWS,
    loadKeywords: vi.fn(async () => ({ available: true, keywords: KEYWORDS })),
    loadKeywordDetail: vi.fn(async () => ({ available: true, total: 12, senders: senders(12), subjects: subjects(12) })),
    addTermsToView: vi.fn(async () => ({ ok: true, wasEmpty: false })),
    createViewFromTerms: vi.fn(async (terms) => ({ ok: true, view: { id: 'new', name: terms[0] } })),
    ...overrides,
  }));
};

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
const renderPanel = async (props = {}) => {
  const out = render(<ViewBuilderPanel email={EMAIL} accountId="acct-1" mailbox="INBOX" onClose={() => {}} {...props} />);
  await flush();
  return out;
};
const chips = () => within(screen.getByTestId('view-builder-chips')).getAllByRole('checkbox');
const chip = term => chips().find(el => el.textContent.includes(term));
const pickTarget = id => {
  fireEvent.click(screen.getByTestId('view-builder-target'));
  fireEvent.click(screen.getByTestId(`view-builder-target-option-${id}`));
};

beforeEach(() => { premiumPlan = false; settings = { searchIndexAttachments: true }; make(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('ViewBuilderPanel', () => {
  it('renders one checkbox chip per keyword, unchecked', async () => {
    await renderPanel();
    expect(store.getState().loadKeywords).toHaveBeenCalledWith(EMAIL);
    expect(chips()).toHaveLength(3);
    expect(chips().map(el => el.textContent)).toEqual(expect.arrayContaining([
      expect.stringContaining('fondue'), expect.stringContaining('gruyere'), expect.stringContaining('caquelon')]));
    for (const el of chips()) expect(el.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(chip('fondue'));
    expect(chip('fondue').getAttribute('aria-checked')).toBe('true');
  });

  it('disables both actions until a chip is selected', async () => {
    await renderPanel();
    expect(screen.getByTestId('view-builder-add').disabled).toBe(true);
    expect(screen.getByTestId('view-builder-new').disabled).toBe(true);
    fireEvent.click(chip('fondue'));
    expect(screen.getByTestId('view-builder-new').disabled).toBe(false);
  });

  it('adds the two selected words to the chosen view, then confirms and clears', async () => {
    await renderPanel();
    fireEvent.click(chip('fondue'));
    fireEvent.click(chip('gruyere'));
    pickTarget('v-full');
    await act(async () => { fireEvent.click(screen.getByTestId('view-builder-add')); });
    expect(store.getState().addTermsToView).toHaveBeenCalledWith('v-full', ['fondue', 'gruyere']);
    expect(screen.getByRole('status').textContent).toContain('viewBuilder.added');
    for (const el of chips()) expect(el.getAttribute('aria-checked')).toBe('false');
  });

  it('warns before adding words to a view that searches for none, and saves on the second click', async () => {
    await renderPanel();
    fireEvent.click(chip('fondue'));
    pickTarget('v-empty');
    await act(async () => { fireEvent.click(screen.getByTestId('view-builder-add')); });
    expect(store.getState().addTermsToView).not.toHaveBeenCalled();
    expect(screen.getByTestId('view-builder-empty-warning').textContent).toContain('viewBuilder.emptyQueryWarning');
    await act(async () => { fireEvent.click(screen.getByTestId('view-builder-confirm')); });
    expect(store.getState().addTermsToView).toHaveBeenCalledWith('v-empty', ['fondue']);
  });

  it('makes a new view for the whole account, or for this mailbox when ticked', async () => {
    await renderPanel();
    fireEvent.click(chip('gruyere'));
    await act(async () => { fireEvent.click(screen.getByTestId('view-builder-new')); });
    expect(store.getState().createViewFromTerms).toHaveBeenLastCalledWith(['gruyere'], { accountId: 'acct-1', mailbox: null }, false);
    expect(screen.getByRole('status').textContent).toContain('viewBuilder.created');

    fireEvent.click(chip('fondue'));
    fireEvent.click(screen.getByTestId('view-builder-this-mailbox'));
    await act(async () => { fireEvent.click(screen.getByTestId('view-builder-new')); });
    expect(store.getState().createViewFromTerms).toHaveBeenLastCalledWith(['fondue'], { accountId: 'acct-1', mailbox: 'INBOX' }, false);
  });

  it('reads the account and folder off the email before the props', async () => {
    await renderPanel({ email: { ...EMAIL, _accountId: 'acct-2', _mailbox: 'Archive' } });
    fireEvent.click(chip('fondue'));
    fireEvent.click(screen.getByTestId('view-builder-this-mailbox'));
    await act(async () => { fireEvent.click(screen.getByTestId('view-builder-new')); });
    expect(store.getState().createViewFromTerms).toHaveBeenLastCalledWith(['fondue'], { accountId: 'acct-2', mailbox: 'Archive' }, false);
  });

  it('a save that lands after the email changed leaves the new email alone', async () => {
    let finish;
    make({
      addTermsToView: vi.fn(() => new Promise(r => { finish = r; })),
      loadKeywords: vi.fn(async (email) => ({ available: true, keywords: email.uid === 8 ? [{ term: 'raclette', tf: 1, df: 1 }] : KEYWORDS })),
    });
    const { rerender } = await renderPanel();
    fireEvent.click(chip('fondue'));
    pickTarget('v-full');
    await act(async () => { fireEvent.click(screen.getByTestId('view-builder-add')); });
    rerender(<ViewBuilderPanel email={{ ...EMAIL, uid: 8 }} accountId="acct-1" mailbox="INBOX" onClose={() => {}} />);
    await flush();
    fireEvent.click(chip('raclette'));
    await act(async () => { finish({ ok: true, wasEmpty: false }); });
    expect(screen.queryByRole('status')).toBeNull();
    expect(chip('raclette').getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('view-builder-add').disabled).toBe(false);
  });

  it('shows the free plan limit when a new view is refused', async () => {
    make({ createViewFromTerms: vi.fn(async () => ({ ok: false, reason: 'limit' })) });
    await renderPanel();
    fireEvent.click(chip('fondue'));
    await act(async () => { fireEvent.click(screen.getByTestId('view-builder-new')); });
    expect(screen.getByTestId('view-builder-refused').textContent).toContain('views.limitReached');
  });

  it('reads an unplaceable row as no words and a daemon error as an error, never crashing', async () => {
    make({ loadKeywords: vi.fn(async () => ({ available: false, keywords: [] })) });
    await renderPanel();
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(screen.getByTestId('view-builder-state').textContent).toContain('viewBuilder.unavailable');
    cleanup();
    make({ loadKeywords: vi.fn(async () => { throw new Error('boom'); }) });
    await renderPanel();
    expect(screen.getByTestId('view-builder-state').textContent).toContain('viewBuilder.error');
  });

  it('ignores a stale reply when the email changes', async () => {
    let resolveFirst;
    const loadKeywords = vi.fn()
      .mockImplementationOnce(() => new Promise(r => { resolveFirst = r; }))
      .mockImplementationOnce(async () => ({ available: true, keywords: [{ term: 'second', tf: 1, df: 1 }] }));
    make({ loadKeywords });
    const { rerender } = await renderPanel();
    rerender(<ViewBuilderPanel email={{ ...EMAIL, uid: 8 }} accountId="acct-1" mailbox="INBOX" onClose={() => {}} />);
    await flush();
    await act(async () => { resolveFirst({ available: true, keywords: [{ term: 'first', tf: 1, df: 1 }] }); });
    expect(chips().map(el => el.textContent).join()).toContain('second');
    expect(chips().map(el => el.textContent).join()).not.toContain('first');
  });

  it('does not reload when the same email arrives as a new object', async () => {
    const { rerender } = await renderPanel();
    rerender(<ViewBuilderPanel email={{ ...EMAIL }} accountId="acct-1" mailbox="INBOX" onClose={() => {}} />);
    await flush();
    expect(store.getState().loadKeywords).toHaveBeenCalledTimes(1);
  });

  it('closes through its close button', async () => {
    const onClose = vi.fn();
    await renderPanel({ onClose });
    fireEvent.click(screen.getByRole('button', { name: 'common.close' }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe('KeywordHovercard', () => {
  it('opens after a hover delay, lists at most 10 senders, and closes on Escape', async () => {
    await renderPanel();
    vi.useFakeTimers();
    fireEvent.pointerEnter(chip('fondue'));
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(screen.queryByTestId('keyword-hovercard')).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(400));
    expect(screen.getByTestId('keyword-hovercard')).toBeTruthy();
    await act(() => vi.advanceTimersByTimeAsync(200));
    expect(store.getState().loadKeywordDetail).toHaveBeenCalledWith('fondue');
    expect(screen.getAllByTestId('keyword-hovercard-sender')).toHaveLength(10);
    expect(screen.getAllByTestId('keyword-hovercard-subject').length).toBeLessThanOrEqual(10);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('keyword-hovercard')).toBeNull();
  });

  it('stays open while the pointer moves from the chip onto the card, and closes after leaving both', async () => {
    await renderPanel();
    vi.useFakeTimers();
    fireEvent.pointerEnter(chip('fondue'));
    await act(() => vi.advanceTimersByTimeAsync(400));
    fireEvent.pointerLeave(chip('fondue'));
    await act(() => vi.advanceTimersByTimeAsync(50));
    fireEvent.pointerEnter(screen.getByTestId('keyword-hovercard'));
    await act(() => vi.advanceTimersByTimeAsync(400));
    expect(screen.getByTestId('keyword-hovercard')).toBeTruthy();
    fireEvent.pointerLeave(screen.getByTestId('keyword-hovercard'));
    await act(() => vi.advanceTimersByTimeAsync(400));
    expect(screen.queryByTestId('keyword-hovercard')).toBeNull();
  });

  it('fetches nothing for chips swept over, and each word only once', async () => {
    await renderPanel();
    vi.useFakeTimers();
    for (const term of ['fondue', 'gruyere', 'caquelon']) {
      fireEvent.pointerEnter(chip(term));
      await act(() => vi.advanceTimersByTimeAsync(60));
      fireEvent.pointerLeave(chip(term));
    }
    await act(() => vi.advanceTimersByTimeAsync(600));
    expect(store.getState().loadKeywordDetail).not.toHaveBeenCalled();

    fireEvent.focus(chip('fondue'));
    await act(() => vi.advanceTimersByTimeAsync(400));
    expect(screen.getByTestId('keyword-hovercard')).toBeTruthy();
    fireEvent.blur(chip('fondue'));
    await act(() => vi.advanceTimersByTimeAsync(400));
    expect(screen.queryByTestId('keyword-hovercard')).toBeNull();
    fireEvent.focus(chip('fondue'));
    await act(() => vi.advanceTimersByTimeAsync(400));
    expect(store.getState().loadKeywordDetail).toHaveBeenCalledTimes(1);
  });

  it('asks only about the word Tab comes to rest on', async () => {
    await renderPanel();
    vi.useFakeTimers();
    for (const term of ['fondue', 'gruyere']) {
      fireEvent.focus(chip(term));
      await act(() => vi.advanceTimersByTimeAsync(40));
      fireEvent.blur(chip(term));
    }
    fireEvent.focus(chip('caquelon'));
    await act(() => vi.advanceTimersByTimeAsync(600));
    expect(store.getState().loadKeywordDetail).toHaveBeenCalledTimes(1);
    expect(store.getState().loadKeywordDetail).toHaveBeenCalledWith('caquelon');
  });

  it('a click that focused nothing does not swallow the next keyboard focus', async () => {
    await renderPanel();
    fireEvent.pointerDown(chip('fondue'));
    fireEvent.click(chip('fondue'));
    await act(async () => { fireEvent.focus(chip('gruyere')); });
    expect(screen.getByTestId('keyword-hovercard')).toBeTruthy();
  });

  it('shows the details under React.StrictMode', async () => {
    render(<React.StrictMode><ViewBuilderPanel email={EMAIL} accountId="acct-1" mailbox="INBOX" onClose={() => {}} /></React.StrictMode>);
    await flush();
    await act(async () => { fireEvent.focus(chip('fondue')); });
    expect((await screen.findAllByTestId('keyword-hovercard-sender')).length).toBe(10);
  });

  it('speaks of the word, not the email, while loading', async () => {
    await renderPanel();
    await act(async () => { fireEvent.focus(chip('fondue')); });
    expect(screen.getByTestId('keyword-hovercard').textContent).toContain('viewBuilder.detailLoading');
  });

  it('closes when the reader scrolls, not when the card itself does', async () => {
    await renderPanel();
    await act(async () => { fireEvent.focus(chip('fondue')); });
    fireEvent.scroll(screen.getByTestId('keyword-hovercard'));
    expect(screen.getByTestId('keyword-hovercard')).toBeTruthy();
    fireEvent.scroll(screen.getByTestId('view-builder-panel'));
    expect(screen.queryByTestId('keyword-hovercard')).toBeNull();
  });

  it('opens at once on keyboard focus', async () => {
    await renderPanel();
    await act(async () => { fireEvent.focus(chip('gruyere')); });
    expect(screen.getByTestId('keyword-hovercard')).toBeTruthy();
  });
  describe('identifiers, phrases and attachments', () => {
    beforeEach(() => { premiumPlan = true; make(); });
    const BODY = [
      { term: 'Mindaugo g. 30-49', tf: 1, df: 0, kind: 'phrase', source: 'body' },
      { term: 'vandenu', tf: 2, df: 3, kind: 'word', source: 'body' },
    ];
    const FULL = [
      { term: 'BV530133', tf: 1, df: 0, kind: 'identifier', source: 'attachment' },
      ...BODY,
    ];
    const answering = (first, second) => vi.fn(async (_email, opts) => (opts?.withAttachments ? second : first));

    it('does not reload for a new object of the same email, attachments included', async () => {
      const loadKeywords = answering({ available: true, keywords: BODY }, { available: true, keywords: FULL });
      make({ loadKeywords });
      const { rerender } = await renderPanel();
      rerender(<ViewBuilderPanel email={{ ...EMAIL }} accountId="acct-1" mailbox="INBOX" onClose={() => {}} />);
      await flush();
      expect(loadKeywords).toHaveBeenCalledTimes(2);
    });

    it('asks for the attachments after the words, and shows the identifier they hold', async () => {
      const loadKeywords = answering({ available: true, keywords: BODY }, { available: true, keywords: FULL });
      make({ loadKeywords });
      await renderPanel();
      expect(loadKeywords).toHaveBeenNthCalledWith(1, EMAIL);
      expect(loadKeywords).toHaveBeenNthCalledWith(2, EMAIL, { withAttachments: true });
      expect(chips().map(el => el.textContent)).toEqual(['BV530133', 'Mindaugo g. 30-49', 'vandenu']);
    });

    it('labels a row for each kind, identifiers first', async () => {
      make({ loadKeywords: answering({ available: true, keywords: FULL }, { available: true, keywords: FULL }) });
      await renderPanel();
      const rows = ['identifier', 'phrase', 'word'].map(kind => screen.getByTestId(`view-builder-row-${kind}`));
      expect(rows.map(row => row.querySelector('h4').textContent))
        .toEqual(['viewBuilder.identifiers', 'viewBuilder.phrases', 'viewBuilder.words']);
      expect(within(rows[0]).getAllByRole('checkbox').map(el => el.textContent)).toEqual(['BV530133']);
    });

    it('marks a chip that came from an attachment, and only that one', async () => {
      make({ loadKeywords: answering({ available: true, keywords: FULL }, { available: true, keywords: FULL }) });
      await renderPanel();
      expect(within(chip('BV530133')).getByRole('img', { name: 'viewBuilder.fromAttachment' })).toBeTruthy();
      expect(within(chip('vandenu')).queryByRole('img')).toBeNull();
    });

    it('never reads the attachments without the plan or with the switch off', async () => {
      for (const [plan, setting] of [[false, true], [true, false]]) {
        premiumPlan = plan;
        settings = { searchIndexAttachments: setting };
        const loadKeywords = answering({ available: true, keywords: BODY }, { available: true, keywords: FULL });
        make({ loadKeywords });
        await renderPanel();
        expect(loadKeywords).toHaveBeenCalledTimes(1);
        expect(screen.queryByTestId('view-builder-reading-attachments')).toBeNull();
        cleanup();
      }
    });

    it('shows no row labels while only one kind is on offer', async () => {
      await renderPanel();
      expect(screen.getByTestId('view-builder-row-word').querySelector('h4')).toBeNull();
    });

    it('keeps the first answer when the attachments cannot be read', async () => {
      const loadKeywords = vi.fn(async (_email, opts) => {
        if (opts?.withAttachments) throw new Error('boom');
        return { available: true, keywords: BODY };
      });
      make({ loadKeywords });
      await renderPanel();
      expect(chips().map(el => el.textContent)).toEqual(['Mindaugo g. 30-49', 'vandenu']);
      expect(screen.queryByTestId('view-builder-reading-attachments')).toBeNull();
    });

    it('says the attachments are being read until they answer', async () => {
      let answer;
      const loadKeywords = vi.fn((_email, opts) => (opts?.withAttachments
        ? new Promise(r => { answer = r; })
        : Promise.resolve({ available: true, keywords: BODY })));
      make({ loadKeywords });
      await renderPanel();
      expect(screen.getByTestId('view-builder-reading-attachments')).toBeTruthy();
      await act(async () => { answer({ available: true, keywords: FULL }); });
      expect(screen.queryByTestId('view-builder-reading-attachments')).toBeNull();
      expect(chips()).toHaveLength(3);
    });

    it('adds an identifier to a view like any other term', async () => {
      make({ loadKeywords: answering({ available: true, keywords: FULL }, { available: true, keywords: FULL }) });
      await renderPanel();
      fireEvent.click(chip('BV530133'));
      fireEvent.click(chip('Mindaugo'));
      pickTarget('v-full');
      fireEvent.click(screen.getByTestId('view-builder-add'));
      await flush();
      expect(store.getState().addTermsToView).toHaveBeenCalledWith('v-full', ['BV530133', 'Mindaugo g. 30-49']);
    });
  });
});
