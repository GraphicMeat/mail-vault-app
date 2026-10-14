// @vitest-environment jsdom
//
// The privacy paths with the REAL pieces: the privacy store, the name
// dictionary, usePrivacyDict, the iframe redaction on a DOMParser document,
// BlitzBody and BlitzTiles. Only the daemon seam (../service) is a stand-in.
import React from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act, cleanup } from '@testing-library/react';

vi.mock('../service', () => ({
  openRender: vi.fn(), hitRender: vi.fn(), closeRender: vi.fn(),
  tileUrl: (d, r, i) => `mvrender://localhost/${d}%2F${r}%2F${i}`,
  onRenderUpdated: vi.fn(async () => () => {}),
  textRunsRender: vi.fn(async () => ({ runs: [] })),
}));
const redact = vi.hoisted(() => ({ throws: false }));
vi.mock('../../../utils/iframePrivacyRedact', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    applyPrivacyRedaction: (...args) => {
      if (redact.throws) throw new Error('boom');
      return actual.applyPrivacyRedaction(...args);
    },
  };
});
import { openRender, closeRender } from '../service';
import BlitzBody from '../BlitzBody';
import { usePrivacyStore } from '../../../stores/privacyStore';
import { useSettingsStore } from '../../../stores/settingsStore';
import { setPrivacyDictionary } from '../../../utils/privacy/privacyDictionary';
import { buildNameDictionary, EMPTY_DICTIONARY } from '../../../utils/privacy/piiDetector';

const meta = (over = {}) => ({ cssWidth: 600, cssHeight: 300, tileCssHeight: 512, tileCount: 1, links: [], plainText: '', folds: [], ...over });
const opened = (docId) => ({ docId, rev: 1, meta: meta() });
const NAME = 'Zelda Quimby';
const message = (uid = 1) => ({ uid, _accountId: 'acc', _mailbox: 'INBOX', from: { name: NAME, address: 'zq@example.test' } });
const props = (over = {}) => ({
  surface: 'reader', messageKey: 'p-key-1', message: message(),
  bodyHtml: `<p>Dear ${NAME}</p>`, plainText: `Dear ${NAME}, call me`,
  theme: { dark: false, palette: 'graphite' }, onLink: vi.fn(), sizing: 'content', ...over,
});
const sentHtml = () => openRender.mock.calls.map(c => c[0].html);
const setPrivacy = (state) => act(() => { usePrivacyStore.setState(state); });
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });

beforeAll(async () => { await usePrivacyStore.persist.rehydrate(); });
beforeEach(() => {
  vi.clearAllMocks();
  redact.throws = false;
  globalThis.ResizeObserver = class { constructor(cb) { this.cb = cb; } observe(el) { this.cb([{ contentRect: { width: 600 }, target: el }]); } disconnect() {} };
  globalThis.IntersectionObserver = class { constructor(cb) { this.cb = cb; } observe(el) { this.cb([{ isIntersecting: true, target: el }]); } unobserve() {} disconnect() {} };
  // The global dictionary is empty on purpose: the name travels on the message
  // only, so a pass that forgets the message's own parties leaks it.
  setPrivacyDictionary(EMPTY_DICTIONARY, { ready: true });
  usePrivacyStore.setState({ enabled: false, peek: false, captureMask: false, captureReveal: null });
  useSettingsStore.setState({ emailRenderer: 'blitz' });
});
afterEach(() => {
  cleanup();
  usePrivacyStore.setState({ enabled: false, peek: false, captureMask: false, captureReveal: null });
  setPrivacyDictionary(EMPTY_DICTIONARY, { ready: true });
});

describe('BlitzBody privacy flips', () => {
  it('turning privacy on removes the drawn tiles at once and closes the doc', async () => {
    openRender.mockResolvedValueOnce(opened(1));
    render(<BlitzBody {...props()} />);
    await screen.findAllByTestId('blitz-tile');
    openRender.mockReturnValue(new Promise(() => {})); // the masked open stays pending
    expect(closeRender).not.toHaveBeenCalled();
    setPrivacy({ enabled: true });
    expect(screen.queryAllByTestId('blitz-tile')).toHaveLength(0);
    expect(closeRender).toHaveBeenCalledWith(1);
    await flush();
    expect(screen.queryAllByTestId('blitz-tile')).toHaveLength(0);
    for (const html of sentHtml().slice(1)) expect(html).not.toContain('Zelda');
  });

  it('releasing a peek removes the unmasked tiles at once', async () => {
    setPrivacy({ enabled: true, peek: true });
    openRender.mockResolvedValueOnce(opened(1));
    render(<BlitzBody {...props()} />);
    await screen.findAllByTestId('blitz-tile');
    expect(sentHtml().at(-1)).toContain(NAME); // the peek really drew it unmasked
    openRender.mockReturnValue(new Promise(() => {}));
    setPrivacy({ peek: false });
    expect(screen.queryAllByTestId('blitz-tile')).toHaveLength(0);
    expect(closeRender).toHaveBeenCalledWith(1);
  });

  it('a capture mask clears the unmasked tiles the same way', async () => {
    openRender.mockResolvedValueOnce(opened(1));
    render(<BlitzBody {...props()} />);
    await screen.findAllByTestId('blitz-tile');
    openRender.mockReturnValue(new Promise(() => {}));
    setPrivacy({ captureMask: true });
    expect(screen.queryAllByTestId('blitz-tile')).toHaveLength(0);
    expect(closeRender).toHaveBeenCalledWith(1);
  });

  it('a body with nothing to mask still comes back after privacy turns on', async () => {
    const plain = props({ bodyHtml: '<p>Nothing private in here</p>', plainText: 'x', message: null });
    openRender.mockResolvedValueOnce(opened(1)).mockResolvedValueOnce(opened(2));
    render(<BlitzBody {...plain} />);
    await screen.findAllByTestId('blitz-tile');
    setPrivacy({ enabled: true });
    await waitFor(() => expect(screen.getAllByTestId('blitz-tile')[0].getAttribute('src')).toContain('2%2F1%2F0'));
  });

  it('a dictionary update with the same names does not reopen the doc', async () => {
    setPrivacyDictionary(buildNameDictionary({ names: [NAME] }), { ready: true });
    setPrivacy({ enabled: true });
    openRender.mockResolvedValue(opened(1));
    render(<BlitzBody {...props()} />);
    await screen.findAllByTestId('blitz-tile');
    expect(openRender).toHaveBeenCalledTimes(1);
    act(() => setPrivacyDictionary(buildNameDictionary({ names: [NAME] }), { ready: true }));
    await flush();
    act(() => setPrivacyDictionary(buildNameDictionary({ names: [NAME] }), { ready: true }));
    await flush();
    expect(openRender).toHaveBeenCalledTimes(1);
    expect(closeRender).not.toHaveBeenCalled();
    expect(screen.getAllByTestId('blitz-tile')).toHaveLength(1);
  });

  it('a dictionary that gains a name re-masks without remounting the tiles', async () => {
    setPrivacy({ enabled: true });
    openRender.mockResolvedValueOnce(opened(1));
    render(<BlitzBody {...props({ message: null, bodyHtml: '<p>Dear Hugo Brandt</p>', plainText: 'x' })} />);
    await screen.findAllByTestId('blitz-tile');
    expect(sentHtml().at(-1)).toContain('Hugo');
    openRender.mockResolvedValueOnce(opened(2));
    act(() => setPrivacyDictionary(buildNameDictionary({ names: ['Hugo Brandt'] }), { ready: true }));
    await waitFor(() => expect(openRender).toHaveBeenCalledTimes(2));
    expect(sentHtml().at(-1)).not.toContain('Hugo');
  });
});

describe('BlitzBody message keys', () => {
  it('two messages without a key each get the bubble, and do not share a drawn body', async () => {
    openRender.mockRejectedValue(new Error('render_too_complex'));
    const first = render(<BlitzBody {...props({ messageKey: null, message: message(101), bodyHtml: '<p>one</p>', plainText: 'one' })} />);
    await screen.findByTestId('blitz-failure-notice');
    expect(screen.getByTestId('blitz-failure-bubble')).toBeTruthy();
    first.unmount();
    render(<BlitzBody {...props({ messageKey: null, message: message(102), bodyHtml: '<p>two</p>', plainText: 'two' })} />);
    await screen.findByTestId('blitz-failure-notice');
    expect(screen.getByTestId('blitz-failure-bubble')).toBeTruthy();
  });

  it('switching between two keyless messages clears the first one\'s tiles in that render', async () => {
    openRender.mockResolvedValueOnce(opened(1));
    const { rerender } = render(<BlitzBody {...props({ messageKey: null, message: message(201), bodyHtml: '<p>one</p>', plainText: 'one' })} />);
    await screen.findAllByTestId('blitz-tile');
    openRender.mockReturnValue(new Promise(() => {}));
    rerender(<BlitzBody {...props({ messageKey: null, message: message(202), bodyHtml: '<p>two</p>', plainText: 'two' })} />);
    expect(screen.queryAllByTestId('blitz-tile')).toHaveLength(0);
    expect(closeRender).toHaveBeenCalledWith(1);
  });
});
