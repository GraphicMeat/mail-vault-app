// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from '@testing-library/react';
let lastClone = null;
let lastOpts = null;
let maskDuringCapture = null;
let themeDuringCapture = null;
let revealDuringCapture = null;
let detailsDuringCapture = null;
// Every rasterizer call: the node as it stood live, and the clone it drew.
let calls = [];
// jsdom has no 2d context: a stub that records the composite's draws.
const ctx = { save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), rect: vi.fn(), clip: vi.fn(), fillRect: vi.fn(), drawImage: vi.fn() };
const fakeCanvas = () => Object.assign(document.createElement('canvas'), { width: 10, height: 10, getContext: () => ctx });
vi.mock('modern-screenshot', () => ({
  domToCanvas: vi.fn(async (node, opts) => {
    const { usePrivacyStore: store } = await import('../../../../stores/privacyStore');
    maskDuringCapture = store.getState().captureMask;
    const { useThemeStore: themes } = await import('../../../../stores/themeStore');
    themeDuringCapture = themes.getState().captureTheme;
    revealDuringCapture = store.getState().captureReveal;
    detailsDuringCapture = store.getState().captureSenderDetails;
    const live = node.outerHTML;
    const clone = node.cloneNode(true);
    await opts.onCloneNode?.(clone);
    lastClone = clone;
    lastOpts = opts;
    calls.push({ node, live, clone });
    return fakeCanvas();
  }),
}));
import { captureAppWindow } from '../captureAppWindow';
import { buildNameDictionary } from '../../../../utils/privacy/piiDetector';
import { usePrivacyStore } from '../../../../stores/privacyStore';
import { useThemeStore } from '../../../../stores/themeStore';
import { NEEDLES, PEOPLE } from '../../../../test/privacyFixtures';
import { Private } from '../../../../components/privacy/Private';

afterEach(() => {
  document.body.innerHTML = ''; lastClone = null; lastOpts = null; maskDuringCapture = null; themeDuringCapture = null; revealDuringCapture = null; detailsDuringCapture = null; calls = [];
  usePrivacyStore.setState({ captureReveal: null, captureSenderDetails: null });
  useThemeStore.setState({ theme: 'dark', captureTheme: null });
  document.documentElement.setAttribute('data-theme', 'dark');
  // The composite also sets fillStyle on it: clear only the spies.
  Object.values(ctx).forEach(f => f?.mockClear?.());
  vi.restoreAllMocks();
});
const noNeedle = (html) => NEEDLES.forEach(n => expect(html, n).not.toContain(n));
const box = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top });

describe('captureAppWindow', () => {
  it('redacts every text node and attribute of the clone, and restores capture mask after', async () => {
    document.body.innerHTML = '<div id="root"><span title="Joanna Kowalczyk">Joanna Kowalczyk</span> joanna.k@example.org</div>';
    await captureAppWindow({ redact: true, dict: buildNameDictionary({ names: ['Joanna Kowalczyk'] }) });
    expect(lastClone.outerHTML).not.toMatch(/Joanna|Kowalczyk|joanna\.k@/);
    expect(maskDuringCapture).toBe(true);
    expect(usePrivacyStore.getState().captureMask).toBe(false);
  });

  it('without redact, leaves the clone alone', async () => {
    document.body.innerHTML = '<div id="root">Joanna Kowalczyk</div>';
    await captureAppWindow({ redact: false, dict: null });
    expect(lastClone.textContent).toContain('Joanna Kowalczyk');
    expect(maskDuringCapture).toBe(false);
  });

  it('drops a frame srcdoc (the raw body) from the clone, redacted or not', async () => {
    document.body.innerHTML = '<div id="root"><iframe srcdoc="<p>Joanna Kowalczyk +370 612 34567</p>"></iframe></div>';
    await captureAppWindow({ redact: false, dict: null });
    expect(lastClone.querySelector('iframe').hasAttribute('srcdoc')).toBe(false);
    const html = lastClone.outerHTML;
    NEEDLES.forEach(n => expect(html, n).not.toContain(n));
  });

  it('leaves out whatever is marked data-capture-exclude', async () => {
    document.body.innerHTML = '<div id="root"><div data-capture-exclude=""><p>x</p></div><p id="kept">y</p></div>';
    await captureAppWindow({ redact: false, dict: null });
    const [excluded, inner, kept] = ['[data-capture-exclude]', '[data-capture-exclude] p', '#kept'].map(s => document.querySelector(s));
    expect(lastOpts.filter(excluded)).toBe(false);
    expect(lastOpts.filter(inner)).toBe(false);
    expect(lastOpts.filter(kept)).toBe(true);
    expect(lastOpts.filter(kept.firstChild)).toBe(true); // a text node
  });

  it('keeps the mask up from the first of two overlapping captures until the last ends', async () => {
    const { domToCanvas } = await import('modern-screenshot');
    const releases = [];
    for (let i = 0; i < 2; i += 1) {
      domToCanvas.mockImplementationOnce(() => new Promise((resolve) => {
        releases.push(() => resolve(Object.assign(document.createElement('canvas'), { width: 10, height: 10 })));
      }));
    }
    document.body.innerHTML = '<div id="root">a</div>';
    const dict = buildNameDictionary({ names: [] });
    const first = captureAppWindow({ redact: true, dict });
    const second = captureAppWindow({ redact: true, dict });
    // Captures run one at a time: the second has not reached the rasterizer yet.
    await vi.waitFor(() => expect(releases.length).toBe(1));
    releases[0]();
    await first;
    // No gap between the two: the mask is still up while the second runs.
    expect(usePrivacyStore.getState().captureMask).toBe(true);
    await vi.waitFor(() => expect(releases.length).toBe(2));
    releases[1]();
    await second;
    expect(usePrivacyStore.getState().captureMask).toBe(false);
  });

  it('restores the capture mask when the capture throws', async () => {
    const { domToCanvas } = await import('modern-screenshot');
    domToCanvas.mockRejectedValueOnce(new Error('boom'));
    document.body.innerHTML = '<div id="root">a</div>';
    await expect(captureAppWindow({ redact: true, dict: buildNameDictionary({ names: [] }) })).rejects.toThrow('boom');
    expect(usePrivacyStore.getState().captureMask).toBe(false);
  });

  it('composites each message frame, and the frame body it draws holds nobody', async () => {
    document.body.innerHTML = '<div id="root"><p>chrome</p><iframe></iframe></div>';
    const root = document.getElementById('root');
    const iframe = root.querySelector('iframe');
    const frameDoc = iframe.contentDocument;
    frameDoc.body.innerHTML = '<p title="Joanna Kowalczyk">Hi Rokas Ambrazevičius, mail joanna.k@example.org or call +370 612 34567</p>';
    // jsdom lays nothing out: without rects the composite skips every frame.
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(box(0, 0, 800, 600));
    vi.spyOn(iframe, 'getBoundingClientRect').mockReturnValue(box(200, 50, 500, 400));
    vi.spyOn(frameDoc.body, 'getBoundingClientRect').mockReturnValue(box(8, 8, 484, 300));
    await captureAppWindow({ redact: true, dict: buildNameDictionary({ names: PEOPLE.names }) });
    const frameCall = calls.find(c => c.node === frameDoc.body);
    expect(frameCall).toBeTruthy();
    noNeedle(frameCall.clone.outerHTML);
    expect(frameCall.clone.querySelector('.mv-pii')).toBeTruthy();
    // Painted over the frame's rect, at 2x: frame origin + body offset.
    expect(ctx.drawImage).toHaveBeenCalledWith(expect.anything(), (200 + 8) * 2, (50 + 8) * 2, 484 * 2, 300 * 2);
  });

  it('masks the live React surfaces (captureMask) before the rasterizer reads them', async () => {
    vi.spyOn(usePrivacyStore.persist, 'hasHydrated').mockReturnValue(true);
    usePrivacyStore.setState({ enabled: false, peek: false, captureMask: false });
    document.body.innerHTML = '<div id="root"></div>';
    const reactRoot = createRoot(document.getElementById('root'));
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    act(() => reactRoot.render(React.createElement('p', null,
      React.createElement(Private, { kind: 'name' }, PEOPLE.names[0]), ' · ',
      React.createElement(Private, { kind: 'email' }, PEOPLE.emails[0]))));
    expect(document.getElementById('root').textContent).toContain(PEOPLE.names[0]);
    // The capture runs outside act: React must render the masked frame on its own, before domToCanvas.
    globalThis.IS_REACT_ACT_ENVIRONMENT = false;
    try {
      await captureAppWindow({ redact: true, dict: buildNameDictionary({ names: [] }) });
    } finally {
      globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    }
    const rootCall = calls.find(c => c.node.id === 'root');
    noNeedle(rootCall.live);
    expect(rootCall.live).toContain('xxxxxx xxxxxxxxx');
    // And back once the capture is done.
    await vi.waitFor(() => expect(document.getElementById('root').textContent).toContain(PEOPLE.names[0]));
    act(() => reactRoot.unmount());
  });

  it('keeps the app\'s own labels when a contact shares a word with them, and still masks the contact', async () => {
    // A sender called "Google Search" puts "search" in the dictionary.
    const dict = buildNameDictionary({ names: ['Google Search', 'Joanna Kowalczyk'] });
    document.body.innerHTML = '<div id="root"><h2>Search Results</h2><input placeholder="Search emails..."><button>Search</button>'
      + '<p>Joanna Kowalczyk</p><p>Google Search</p></div>';
    await captureAppWindow({ redact: true, dict });
    const clone = lastClone.outerHTML;
    expect(lastClone.querySelector('h2').textContent).toBe('Search Results');
    expect(lastClone.querySelector('button').textContent).toBe('Search');
    expect(lastClone.querySelector('input').getAttribute('placeholder')).toBe('Search emails...');
    expect(clone).not.toMatch(/Joanna|Kowalczyk|Google/);
  });

  it('embeds fonts (no font:false) and fetches remote images through the daemon', async () => {
    document.body.innerHTML = '<div id="root">a</div>';
    await captureAppWindow({ redact: false, dict: null });
    expect(lastOpts.font).not.toBe(false);
    expect(await lastOpts.fetchFn('tauri://localhost/assets/x.woff2')).toBe(false);
  });

  describe('theme override', () => {
    const rootWithFrame = () => {
      document.body.innerHTML = '<div id="root">a<iframe></iframe></div>';
      return document.querySelector('iframe');
    };

    it('shoots in the asked theme while the capture runs, then restores the app theme', async () => {
      document.body.innerHTML = '<div id="root">a</div>';
      useThemeStore.setState({ theme: 'dark' });
      await captureAppWindow({ redact: false, dict: null, theme: 'light' });
      expect(themeDuringCapture).toBe('light');
      expect(useThemeStore.getState().captureTheme).toBeNull();
      expect(useThemeStore.getState().theme).toBe('dark');
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    });

    it('restores the app theme when the capture throws', async () => {
      const { domToCanvas } = await import('modern-screenshot');
      domToCanvas.mockRejectedValueOnce(new Error('boom'));
      document.body.innerHTML = '<div id="root">a</div>';
      await expect(captureAppWindow({ redact: false, dict: null, theme: 'light' })).rejects.toThrow('boom');
      expect(useThemeStore.getState().captureTheme).toBeNull();
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    });

    it('does not touch the theme when it is the app theme already, or none is asked', async () => {
      document.body.innerHTML = '<div id="root">a</div>';
      const spy = vi.spyOn(useThemeStore.getState(), 'setCaptureTheme');
      await captureAppWindow({ redact: false, dict: null, theme: 'dark' });
      await captureAppWindow({ redact: false, dict: null });
      await captureAppWindow({ redact: false, dict: null, theme: 'sepia' });
      expect(themeDuringCapture).toBeNull();
      expect(spy).not.toHaveBeenCalled();
    });

    it('runs captures one at a time, so a second never sees the first one\'s theme', async () => {
      const { domToCanvas } = await import('modern-screenshot');
      let releaseFirst;
      domToCanvas.mockImplementationOnce(() => new Promise((resolve) => {
        releaseFirst = () => resolve(Object.assign(document.createElement('canvas'), { width: 10, height: 10 }));
      }));
      document.body.innerHTML = '<div id="root">a</div>';
      const first = captureAppWindow({ redact: false, dict: null, theme: 'light' });
      const second = captureAppWindow({ redact: false, dict: null });
      await vi.waitFor(() => expect(releaseFirst).toBeTruthy());
      await new Promise((r) => setTimeout(r, 80));
      expect(calls).toHaveLength(0); // the second has not started
      expect(useThemeStore.getState().captureTheme).toBe('light');
      releaseFirst();
      await first;
      await second;
      expect(calls).toHaveLength(1);
      expect(themeDuringCapture).toBeNull(); // the second ran after the theme was restored
    });

    it('a failed capture does not break the queue', async () => {
      const { domToCanvas } = await import('modern-screenshot');
      domToCanvas.mockRejectedValueOnce(new Error('boom'));
      document.body.innerHTML = '<div id="root">a</div>';
      const first = captureAppWindow({ redact: false, dict: null });
      const second = captureAppWindow({ redact: false, dict: null });
      await expect(first).rejects.toThrow('boom');
      await expect(second).resolves.toBeTruthy();
    });

    it('waits for a frame that reloads on the flip before it draws', async () => {
      const iframe = rootWithFrame();
      iframe.setAttribute('srcdoc', '<p>dark</p>');
      const oldDoc = { readyState: 'complete', body: {}, getElementById: () => null };
      let current = oldDoc;
      Object.defineProperty(iframe, 'contentDocument', { get: () => current });
      let ready = false;
      // The reader rebuilds its srcdoc on the flip and loads the new document a while later.
      const unsubscribe = useThemeStore.subscribe((s) => {
        if (s.captureTheme !== 'light') return;
        iframe.setAttribute('srcdoc', '<p>light</p>');
        current = { readyState: 'loading', body: null, getElementById: () => null };
        setTimeout(() => {
          current = { readyState: 'complete', body: {}, getElementById: () => null };
          ready = true;
        }, 150);
      });
      const { domToCanvas } = await import('modern-screenshot');
      let readyAtDraw = null;
      domToCanvas.mockImplementationOnce(async () => { readyAtDraw = ready; return fakeCanvas(); });
      try {
        await captureAppWindow({ redact: false, dict: null, theme: 'light' });
      } finally {
        unsubscribe();
      }
      expect(readyAtDraw).toBe(true);
    });

    it('waits out the privacy gate of a reloaded frame when redacting', async () => {
      const iframe = rootWithFrame();
      iframe.setAttribute('srcdoc', '<p>dark</p>');
      let current = { readyState: 'complete', body: {}, getElementById: () => null };
      Object.defineProperty(iframe, 'contentDocument', { get: () => current });
      let gated = false;
      const unsubscribe = useThemeStore.subscribe((s) => {
        if (s.captureTheme !== 'light') return;
        iframe.setAttribute('srcdoc', '<p>light</p>');
        gated = true;
        current = { readyState: 'complete', body: {}, getElementById: (id) => (gated && id === 'mv-privacy-gate' ? {} : null) };
        setTimeout(() => { gated = false; }, 150);
      });
      const { domToCanvas } = await import('modern-screenshot');
      let gatedAtDraw = null;
      domToCanvas.mockImplementationOnce(async () => { gatedAtDraw = gated; return fakeCanvas(); });
      try {
        await captureAppWindow({ redact: true, dict: buildNameDictionary({ names: [] }), theme: 'light' });
      } finally {
        unsubscribe();
      }
      expect(gatedAtDraw).toBe(false);
    });

    it('draws anyway when a frame never settles', async () => {
      const iframe = rootWithFrame();
      iframe.setAttribute('srcdoc', '<p>dark</p>');
      let current = { readyState: 'complete', body: {}, getElementById: () => null };
      Object.defineProperty(iframe, 'contentDocument', { get: () => current });
      const unsubscribe = useThemeStore.subscribe((s) => {
        if (s.captureTheme !== 'light') return;
        iframe.setAttribute('srcdoc', '<p>light</p>');
        current = { readyState: 'loading', body: null, getElementById: () => null };
      });
      try {
        await expect(captureAppWindow({ redact: false, dict: null, theme: 'light' })).resolves.toBeTruthy();
      } finally {
        unsubscribe();
      }
      expect(useThemeStore.getState().captureTheme).toBeNull();
    }, 8000);
  });

  describe('reveal and sender details', () => {
    const dict = () => buildNameDictionary({ names: ['Prize Desk', 'Joanna Kowalczyk'] });
    const SPAM_ROOT = '<div id="root"><span>Prize Desk</span> <span>win@prize.example</span> <span>Joanna Kowalczyk</span> <span>joanna.k@example.org</span></div>';

    it('leaves the exact revealed values readable in the clone, masks everyone else, and clears the reveal after', async () => {
      document.body.innerHTML = SPAM_ROOT;
      await captureAppWindow({ redact: true, dict: dict(), reveal: ['Win@Prize.example', 'prize desk'] });
      expect(lastClone.textContent).toContain('Prize Desk');
      expect(lastClone.textContent).toContain('win@prize.example');
      expect(lastClone.textContent).not.toContain('Joanna');
      expect(lastClone.textContent).not.toContain('joanna.k@example.org');
      expect([...revealDuringCapture].sort()).toEqual(['prize desk', 'win@prize.example']);
      expect(usePrivacyStore.getState().captureReveal).toBeNull();
    });

    it('the caller\'s dictionary is not given a reveal (the host\'s is shared)', async () => {
      document.body.innerHTML = SPAM_ROOT;
      const shared = dict();
      await captureAppWindow({ redact: true, dict: shared, reveal: ['win@prize.example'] });
      expect(shared).not.toHaveProperty('reveal');
    });

    it('reveal needs a redacted capture: without redact nothing is set', async () => {
      document.body.innerHTML = SPAM_ROOT;
      await captureAppWindow({ redact: false, dict: null, reveal: ['win@prize.example'] });
      expect(revealDuringCapture).toBeNull();
    });

    it('with no reveal, the sender is masked like anyone', async () => {
      document.body.innerHTML = SPAM_ROOT;
      await captureAppWindow({ redact: true, dict: dict() });
      expect(lastClone.textContent).not.toContain('win@prize.example');
      expect(lastClone.textContent).not.toContain('Prize Desk');
      expect(revealDuringCapture).toBeNull();
    });

    it('clears the reveal when the capture throws', async () => {
      const { domToCanvas } = await import('modern-screenshot');
      domToCanvas.mockRejectedValueOnce(new Error('boom'));
      document.body.innerHTML = SPAM_ROOT;
      await expect(captureAppWindow({ redact: true, dict: dict(), reveal: ['win@prize.example'] })).rejects.toThrow('boom');
      expect(usePrivacyStore.getState().captureReveal).toBeNull();
      expect(usePrivacyStore.getState().captureSenderDetails).toBeNull();
    });

    it('clears the reveal when there is no app root', async () => {
      document.body.innerHTML = '';
      await expect(captureAppWindow({ redact: true, dict: dict(), reveal: ['win@prize.example'] })).rejects.toThrow('no app root');
      expect(usePrivacyStore.getState().captureReveal).toBeNull();
    });

    it('opens the message\'s sender details for the length of the capture only', async () => {
      document.body.innerHTML = '<div id="root">a</div>';
      const target = { uid: 7, accountId: 'acct', mailbox: 'Junk' };
      await captureAppWindow({ redact: false, dict: null, senderDetails: target });
      expect(detailsDuringCapture).toEqual(target);
      expect(usePrivacyStore.getState().captureSenderDetails).toBeNull();
      await captureAppWindow({ redact: false, dict: null });
      expect(detailsDuringCapture).toBeNull();
    });

    it('puts a floating popover back over the frame composite', async () => {
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx);
      document.body.innerHTML = '<div id="root"><div data-capture-overlay="">popover</div><iframe></iframe></div>';
      const root = document.getElementById('root');
      const iframe = root.querySelector('iframe');
      const frameDoc = iframe.contentDocument;
      frameDoc.body.innerHTML = '<p>body</p>';
      vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(box(0, 0, 800, 600));
      vi.spyOn(root.querySelector('[data-capture-overlay]'), 'getBoundingClientRect').mockReturnValue(box(100, 40, 320, 200));
      vi.spyOn(iframe, 'getBoundingClientRect').mockReturnValue(box(0, 30, 800, 570));
      vi.spyOn(frameDoc.body, 'getBoundingClientRect').mockReturnValue(box(8, 8, 784, 300));
      await captureAppWindow({ redact: false, dict: null });
      const last = ctx.drawImage.mock.calls.at(-1);
      // From the clone as it stood before the frame was painted, at 2x, into the same place.
      expect(last[0]).toBeInstanceOf(HTMLCanvasElement);
      expect(last.slice(1)).toEqual([200, 80, 640, 400, 200, 80, 640, 400]);
    });
  });
});
