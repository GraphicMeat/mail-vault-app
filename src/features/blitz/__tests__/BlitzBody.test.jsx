// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { useSettingsStore } from '../../../stores/settingsStore';

const tilesProps = vi.hoisted(() => ({ last: null }));
vi.mock('../BlitzTiles', () => ({
  // BlitzBody hands its tiles a ref (the selection root), so the real one is a forwardRef; so is the stub.
  default: React.forwardRef((p, _ref) => { tilesProps.last = p; return <div data-testid="tiles-stub"><button onClick={() => p.onFailure('render_unavailable')}>fail</button></div>; }),
}));
const privacy = vi.hoisted(() => ({ hold: false, active: false }));
vi.mock('../prepass/privacyDict', () => ({ usePrivacyDict: () => ({ active: privacy.active, dict: null, hold: privacy.hold }) }));
import BlitzBody from '../BlitzBody';

const props = (over = {}) => ({
  surface: 'reader', messageKey: 'acc:INBOX:1', bodyHtml: '<p>Hello</p><script>x()</script>', plainText: 'Hello plain',
  theme: { dark: false, palette: 'graphite' }, onLink: vi.fn(), sizing: 'content', ...over,
});

beforeEach(() => { tilesProps.last = null; privacy.hold = false; privacy.active = false; useSettingsStore.setState({ emailRenderer: 'blitz' }); });
afterEach(cleanup);

describe('BlitzBody', () => {
  it('hands BlitzTiles the pre-passed HTML with the body and no viewer scripts', async () => {
    render(<BlitzBody {...props()} />);
    await screen.findByTestId('tiles-stub');
    expect(tilesProps.last.html).toContain('<p>Hello</p>');
    expect(tilesProps.last.html).not.toMatch(/<script nonce=/);
  });
  it('tells the tiles whether privacy is on, so the hover chip can stay hidden', async () => {
    const { unmount } = render(<BlitzBody {...props({ messageKey: 'k-priv-off' })} />);
    await screen.findByTestId('tiles-stub');
    expect(tilesProps.last.privacy).toBe(false);
    unmount();
    privacy.active = true;
    render(<BlitzBody {...props({ messageKey: 'k-priv-on' })} />);
    await screen.findByTestId('tiles-stub');
    expect(tilesProps.last.privacy).toBe(true);
  });
  it('privacy hold draws nothing at all', async () => {
    privacy.hold = true;
    render(<BlitzBody {...props()} />);
    await new Promise(r => setTimeout(r, 0));
    expect(screen.queryByTestId('tiles-stub')).toBeNull();
    expect(document.body.textContent).not.toContain('Hello');
  });
  it('failure shows plain text, the notice and the bubble; switch flips the setting', async () => {
    render(<BlitzBody {...props({ messageKey: 'k-fail-1' })} />);
    fireEvent.click(await screen.findByText('fail'));
    expect(screen.getByTestId('blitz-failure-notice')).toBeTruthy();
    expect(screen.getByText('Hello plain')).toBeTruthy();
    fireEvent.click(screen.getByTestId('blitz-failure-switch'));
    expect(useSettingsStore.getState().emailRenderer).toBe('web');
    expect(document.querySelector('iframe')).toBeNull();
  });
  it('the bubble shows once per message per session', async () => {
    const { unmount } = render(<BlitzBody {...props({ messageKey: 'k-once' })} />);
    fireEvent.click(await screen.findByText('fail'));
    expect(screen.getByTestId('blitz-failure-bubble')).toBeTruthy();
    unmount();
    render(<BlitzBody {...props({ messageKey: 'k-once' })} />);
    fireEvent.click(await screen.findByText('fail'));
    expect(screen.getByTestId('blitz-failure-notice')).toBeTruthy();
    expect(screen.queryByTestId('blitz-failure-bubble')).toBeNull();
  });
  it('a re-run with the same message keeps the tiles mounted (no blank between)', async () => {
    const { rerender } = render(<BlitzBody {...props({ messageKey: 'k-keep' })} />);
    await screen.findByTestId('tiles-stub');
    rerender(<BlitzBody {...props({ messageKey: 'k-keep', theme: { dark: true, palette: 'graphite' } })} />);
    expect(screen.getByTestId('tiles-stub')).toBeTruthy();
  });

  it('a new message resets the failed state', async () => {
    const { rerender } = render(<BlitzBody {...props({ messageKey: 'k-a' })} />);
    fireEvent.click(await screen.findByText('fail'));
    rerender(<BlitzBody {...props({ messageKey: 'k-b', bodyHtml: '<p>B</p>' })} />);
    expect(await screen.findByTestId('tiles-stub')).toBeTruthy();
    expect(screen.queryByTestId('blitz-failure-bubble')).toBeNull();
  });
  it('falls back to body text when there is no plain part', async () => {
    render(<BlitzBody {...props({ messageKey: 'k-html-only', plainText: '' })} />);
    fireEvent.click(await screen.findByText('fail'));
    expect(screen.getByText(/Hello/)).toBeTruthy();
  });

  it('a search query change reaches the tiles after a 150 ms debounce, with marks', async () => {
    vi.useFakeTimers();
    const { rerender } = render(<BlitzBody {...props({ messageKey: 'k-search', bodyHtml: '<p>invoice here</p>', searchQuery: '' })} />);
    await vi.runAllTimersAsync();
    const before = tilesProps.last.html;
    rerender(<BlitzBody {...props({ messageKey: 'k-search', bodyHtml: '<p>invoice here</p>', searchQuery: 'inv' })} />);
    rerender(<BlitzBody {...props({ messageKey: 'k-search', bodyHtml: '<p>invoice here</p>', searchQuery: 'invoice' })} />);
    await vi.advanceTimersByTimeAsync(149);
    expect(tilesProps.last.html).toBe(before);
    await vi.advanceTimersByTimeAsync(1);
    await vi.runAllTimersAsync();
    expect(tilesProps.last.html).toContain('mv-search-hit');
    vi.useRealTimers();
  });

  it('an opened fold stays open across a re-open (search change)', async () => {
    vi.useFakeTimers();
    const body = '<p>Reply</p><blockquote><p>Q</p></blockquote>';
    const { rerender } = render(<BlitzBody {...props({ messageKey: 'k-fold', bodyHtml: body, searchQuery: '' })} />);
    await vi.runAllTimersAsync();
    act(() => tilesProps.last.onFoldToggled('q0', true));
    rerender(<BlitzBody {...props({ messageKey: 'k-fold', bodyHtml: body, searchQuery: 'reply' })} />);
    await vi.advanceTimersByTimeAsync(150);
    await vi.runAllTimersAsync();
    expect(tilesProps.last.html).toMatch(/data-mv-fold="q0"[^>]*data-mv-fold-open="true"|data-mv-fold-open="true"[^>]*data-mv-fold="q0"/);
    vi.useRealTimers();
  });

  it('folds a new message again: open folds are per message', async () => {
    vi.useFakeTimers();
    const body = '<p>Reply</p><blockquote><p>Q</p></blockquote>';
    const { rerender } = render(<BlitzBody {...props({ messageKey: 'k-fold-a', bodyHtml: body })} />);
    await vi.runAllTimersAsync();
    act(() => tilesProps.last.onFoldToggled('q0', true));
    rerender(<BlitzBody {...props({ messageKey: 'k-fold-b', bodyHtml: body })} />);
    await vi.runAllTimersAsync();
    expect(tilesProps.last.html).toContain('data-mv-fold-open="false"');
    vi.useRealTimers();
  });

  it('a late fold toggle from the previous message does not open the new message\'s fold', async () => {
    vi.useFakeTimers();
    const body = '<p>Reply</p><blockquote><p>Q</p></blockquote>';
    const { rerender } = render(<BlitzBody {...props({ messageKey: 'k-late-a', bodyHtml: body })} />);
    await vi.runAllTimersAsync();
    const stale = tilesProps.last.onFoldToggled;
    rerender(<BlitzBody {...props({ messageKey: 'k-late-b', bodyHtml: body })} />);
    await vi.runAllTimersAsync();
    act(() => stale('q0', true));
    rerender(<BlitzBody {...props({ messageKey: 'k-late-b', bodyHtml: body, searchQuery: 'reply' })} />);
    await vi.advanceTimersByTimeAsync(150);
    await vi.runAllTimersAsync();
    expect(tilesProps.last.html).toContain('data-mv-fold-open="false"');
    expect(tilesProps.last.html).not.toContain('data-mv-fold-open="true"');
    vi.useRealTimers();
  });

  it('an opened fold stays open across a privacy toggle', async () => {
    vi.useFakeTimers();
    const body = '<p>Reply</p><blockquote><p>Q</p></blockquote>';
    const { rerender } = render(<BlitzBody {...props({ messageKey: 'k-fold-priv', bodyHtml: body })} />);
    await vi.runAllTimersAsync();
    act(() => tilesProps.last.onFoldToggled('q0', true));
    privacy.active = true;
    rerender(<BlitzBody {...props({ messageKey: 'k-fold-priv', bodyHtml: body })} />);
    await vi.runAllTimersAsync();
    expect(tilesProps.last.privacy).toBe(true);
    expect(tilesProps.last.html).toContain('data-mv-fold-open="true"');
    vi.useRealTimers();
  });
});
