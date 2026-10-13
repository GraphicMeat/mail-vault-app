// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { useSettingsStore } from '../../../stores/settingsStore';

const tilesProps = vi.hoisted(() => ({ last: null }));
vi.mock('../BlitzTiles', () => ({
  default: (p) => { tilesProps.last = p; return <div data-testid="tiles-stub"><button onClick={() => p.onFailure('render_unavailable')}>fail</button></div>; },
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
});
