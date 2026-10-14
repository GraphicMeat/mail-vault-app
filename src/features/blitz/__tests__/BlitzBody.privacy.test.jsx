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

describe('BlitzBody privacy, real redaction', () => {
  it('sends the daemon masked HTML only, never the real name', async () => {
    setPrivacy({ enabled: true });
    openRender.mockResolvedValue(opened(1));
    render(<BlitzBody {...props()} />);
    await screen.findAllByTestId('blitz-tile');
    expect(sentHtml().length).toBeGreaterThan(0);
    for (const html of sentHtml()) {
      expect(html).not.toContain('Zelda');
      expect(html).not.toContain('Quimby');
      expect(html).toMatch(/x{5}/);
    }
  });

  it('with privacy off the real text goes out untouched', async () => {
    openRender.mockResolvedValue(opened(1));
    render(<BlitzBody {...props()} />);
    await screen.findAllByTestId('blitz-tile');
    expect(sentHtml().at(-1)).toContain(NAME);
  });

  it('the failure view masks the plain text, including the message\'s own parties', async () => {
    setPrivacy({ enabled: true });
    openRender.mockRejectedValue(new Error('render_too_complex'));
    render(<BlitzBody {...props({ messageKey: 'p-fail-masked' })} />);
    await screen.findByTestId('blitz-failure-notice');
    expect(document.body.textContent).not.toContain('Zelda');
    expect(document.body.textContent).not.toContain('Quimby');
    expect(document.querySelector('.email-plain-body').textContent).toMatch(/Dear x+ x+, call me/);
  });

  it('the failure view masks the body text taken from the HTML when there is no plain part', async () => {
    setPrivacy({ enabled: true });
    openRender.mockRejectedValue(new Error('render_unavailable'));
    render(<BlitzBody {...props({ messageKey: 'p-fail-html', plainText: '' })} />);
    await screen.findByTestId('blitz-failure-notice');
    expect(document.body.textContent).not.toContain('Zelda');
    expect(document.querySelector('.email-plain-body').textContent).toMatch(/Dear x+ x+/);
  });

  it('masks an address typed in the failure text, and a mailto link keeps no readable address', async () => {
    setPrivacy({ enabled: true });
    openRender.mockRejectedValue(new Error('render_unavailable'));
    render(<BlitzBody {...props({ messageKey: 'p-fail-addr', plainText: 'write to someone.private@example.test now' })} />);
    await screen.findByTestId('blitz-failure-notice');
    expect(document.body.textContent).not.toContain('someone.private');
    expect(document.body.innerHTML).not.toContain('someone.private');
  });

  it('the failure view shows the real text when privacy is off', async () => {
    openRender.mockRejectedValue(new Error('render_too_complex'));
    render(<BlitzBody {...props({ messageKey: 'p-fail-off' })} />);
    await screen.findByTestId('blitz-failure-notice');
    expect(document.querySelector('.email-plain-body').textContent).toBe(`Dear ${NAME}, call me`);
  });

  it('a failure that is already showing masks the moment privacy turns on', async () => {
    openRender.mockRejectedValue(new Error('render_too_complex'));
    render(<BlitzBody {...props({ messageKey: 'p-fail-flip' })} />);
    await screen.findByTestId('blitz-failure-notice');
    expect(document.body.textContent).toContain('Zelda');
    setPrivacy({ enabled: true });
    expect(document.body.textContent).not.toContain('Zelda');
  });

  it('a failure under a privacy hold shows the notice and no body text at all', async () => {
    openRender.mockRejectedValue(new Error('render_too_complex'));
    render(<BlitzBody {...props({ messageKey: 'p-fail-hold' })} />);
    await screen.findByTestId('blitz-failure-notice');
    setPrivacyDictionary(EMPTY_DICTIONARY, { ready: false });
    setPrivacy({ enabled: true });
    expect(screen.getByTestId('blitz-failure-notice')).toBeTruthy();
    expect(document.querySelector('.email-plain-body')?.textContent ?? '').toBe('');
    expect(document.body.textContent).not.toContain('Dear');
  });

  it('the failure fallback taken from the HTML leaves out style and script text', async () => {
    openRender.mockRejectedValue(new Error('render_unavailable'));
    render(<BlitzBody {...props({
      messageKey: 'p-fail-style', plainText: '',
      bodyHtml: '<style>.a{color:red}</style><p>Hello there</p><script>secret()</script><noscript>nojs</noscript>',
    })} />);
    await screen.findByTestId('blitz-failure-notice');
    const text = document.querySelector('.email-plain-body').textContent;
    expect(text).toContain('Hello there');
    expect(text).not.toContain('color:red');
    expect(text).not.toContain('secret()');
    expect(text).not.toContain('nojs');
  });

  it('a privacy hold draws nothing and never calls the daemon', async () => {
    setPrivacyDictionary(EMPTY_DICTIONARY, { ready: false });
    setPrivacy({ enabled: true });
    render(<BlitzBody {...props()} />);
    await flush();
    expect(screen.getByTestId('blitz-privacy-hold')).toBeTruthy();
    expect(screen.queryAllByTestId('blitz-tile')).toHaveLength(0);
    expect(openRender).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain('Zelda');
  });

  it('a throwing redaction draws nothing and never opens unmasked HTML', async () => {
    redact.throws = true;
    setPrivacy({ enabled: true });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<BlitzBody {...props()} />);
    await flush();
    expect(openRender).not.toHaveBeenCalled();
    expect(screen.queryAllByTestId('blitz-tile')).toHaveLength(0);
    expect(document.body.textContent).not.toContain('Zelda');
    errorSpy.mockRestore();
  });

  it('a redaction that throws after tiles were drawn blanks them and opens nothing new', async () => {
    openRender.mockResolvedValueOnce(opened(1));
    render(<BlitzBody {...props()} />);
    await screen.findAllByTestId('blitz-tile');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    redact.throws = true;
    setPrivacy({ enabled: true });
    await flush();
    expect(screen.queryAllByTestId('blitz-tile')).toHaveLength(0);
    expect(openRender).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });
});
