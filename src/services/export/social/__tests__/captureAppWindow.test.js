// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from '@testing-library/react';
let lastClone = null;
let lastOpts = null;
let maskDuringCapture = null;
// Every rasterizer call: the node as it stood live, and the clone it drew.
let calls = [];
// jsdom has no 2d context: a stub that records the composite's draws.
const ctx = { save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), rect: vi.fn(), clip: vi.fn(), fillRect: vi.fn(), drawImage: vi.fn() };
const fakeCanvas = () => Object.assign(document.createElement('canvas'), { width: 10, height: 10, getContext: () => ctx });
vi.mock('modern-screenshot', () => ({
  domToCanvas: vi.fn(async (node, opts) => {
    const { usePrivacyStore: store } = await import('../../../../stores/privacyStore');
    maskDuringCapture = store.getState().captureMask;
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
import { NEEDLES, PEOPLE } from '../../../../test/privacyFixtures';
import { Private } from '../../../../components/privacy/Private';

afterEach(() => {
  document.body.innerHTML = ''; lastClone = null; lastOpts = null; maskDuringCapture = null; calls = [];
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

  it('keeps the mask up until the last of two overlapping captures ends', async () => {
    const { domToCanvas } = await import('modern-screenshot');
    let releaseFirst;
    domToCanvas.mockImplementationOnce(() => new Promise((resolve) => {
      releaseFirst = () => resolve(Object.assign(document.createElement('canvas'), { width: 10, height: 10 }));
    }));
    let releaseSecond;
    domToCanvas.mockImplementationOnce(() => new Promise((resolve) => {
      releaseSecond = () => resolve(Object.assign(document.createElement('canvas'), { width: 10, height: 10 }));
    }));
    document.body.innerHTML = '<div id="root">a</div>';
    const dict = buildNameDictionary({ names: [] });
    const first = captureAppWindow({ redact: true, dict });
    const second = captureAppWindow({ redact: true, dict });
    await vi.waitFor(() => expect(releaseFirst && releaseSecond).toBeTruthy());
    releaseFirst();
    await first;
    expect(usePrivacyStore.getState().captureMask).toBe(true);
    releaseSecond();
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
});

