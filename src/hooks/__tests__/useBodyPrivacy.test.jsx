// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { useRef } from 'react';
import { render, act, cleanup } from '@testing-library/react';
import { useBodyPrivacy, usePrivacyFrameGate } from '../useBodyPrivacy';
import { usePrivacyStore } from '../../stores/privacyStore';
import { setPrivacyDictionary } from '../../utils/privacy/privacyDictionary';
import { buildNameDictionary, EMPTY_DICTIONARY } from '../../utils/privacy/piiDetector';
import { buildEmailIframeHtml } from '../../utils/emailIframeTemplate';
import { PRIVACY_GATE_ID } from '../../utils/iframePrivacyRedact';
import { applySearchHighlight } from '../../utils/iframeSearchHighlight';
import { useSearchHighlight } from '../useSearchHighlight';
import { useSearchStore } from '../../stores/searchStore';

// jsdom does not load srcdoc, so the test frame's document is written by hand.
function Frame({ html, show = true }) {
  const ref = useRef(null);
  useBodyPrivacy(ref, html, { readyTimeoutMs: 3000 });
  return show ? <iframe ref={ref} title="t" /> : null;
}
// The reader's real pairing: mask first, then the search highlight.
function SearchFrame({ html, message = null }) {
  const ref = useRef(null);
  useBodyPrivacy(ref, html, { message, readyTimeoutMs: 3000 });
  useSearchHighlight(ref, html);
  return <iframe ref={ref} title="t" />;
}
function writeFrame(iframe, html) {
  const d = iframe.contentDocument; d.open(); d.write(html); d.close();
  iframe.dispatchEvent(new Event('load'));
}

beforeEach(() => { vi.useFakeTimers(); usePrivacyStore.setState({ enabled: true, peek: false, captureMask: false }); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); useSearchStore.setState({ searchActive: false, searchQuery: '' }); });

describe('useBodyPrivacy', () => {
  it('keeps the body gated until the dictionary is ready, then shows it masked', () => {
    setPrivacyDictionary(EMPTY_DICTIONARY, { ready: false });
    const html = buildEmailIframeHtml({ bodyHtml: '<p>Hi John Smith</p>', privacy: true });
    const { container } = render(<Frame html={html} />);
    const iframe = container.querySelector('iframe');
    act(() => writeFrame(iframe, html));
    act(() => vi.advanceTimersByTime(500));
    expect(iframe.contentDocument.getElementById(PRIVACY_GATE_ID)).toBeTruthy(); // still hidden
    act(() => setPrivacyDictionary(buildNameDictionary({ names: ['John Smith'] }), { ready: true }));
    act(() => vi.advanceTimersByTime(200));
    expect(iframe.contentDocument.getElementById(PRIVACY_GATE_ID)).toBeNull();
    expect(iframe.contentDocument.body.textContent).not.toMatch(/John|Smith/);
  });
  it('after the timeout, shows regex-masked content rather than staying blank', () => {
    setPrivacyDictionary(EMPTY_DICTIONARY, { ready: false });
    const html = buildEmailIframeHtml({ bodyHtml: '<p>mail a@b.co</p>', privacy: true });
    const { container } = render(<Frame html={html} />);
    const iframe = container.querySelector('iframe');
    act(() => writeFrame(iframe, html));
    act(() => vi.advanceTimersByTime(3200));
    expect(iframe.contentDocument.getElementById(PRIVACY_GATE_ID)).toBeNull();
    expect(iframe.contentDocument.body.textContent).not.toContain('a@b.co');
  });
  it('re-masks text the frame adds later (quote expand)', async () => {
    setPrivacyDictionary(buildNameDictionary({ names: ['John Smith'] }), { ready: true });
    const html = buildEmailIframeHtml({ bodyHtml: '<p>x</p>', privacy: true });
    const { container } = render(<Frame html={html} />);
    const iframe = container.querySelector('iframe');
    act(() => writeFrame(iframe, html));
    const p = iframe.contentDocument.createElement('p'); p.textContent = 'quoted John Smith';
    await act(async () => { iframe.contentDocument.body.appendChild(p); await Promise.resolve(); });
    expect(iframe.contentDocument.body.textContent).not.toMatch(/John|Smith/);
  });
  it('peek restores, release re-masks', () => {
    setPrivacyDictionary(buildNameDictionary({ names: ['John Smith'] }), { ready: true });
    const html = buildEmailIframeHtml({ bodyHtml: '<p>John Smith</p>', privacy: true });
    const { container } = render(<Frame html={html} />);
    const iframe = container.querySelector('iframe');
    act(() => writeFrame(iframe, html));
    act(() => usePrivacyStore.setState({ peek: true }));
    expect(iframe.contentDocument.body.textContent).toContain('John Smith');
    act(() => usePrivacyStore.setState({ peek: false }));
    expect(iframe.contentDocument.body.textContent).not.toContain('John');
  });
  it('holding Option inside the frame peeks, and releasing it masks again', () => {
    // The peek flips masking, which re-runs the mask pass. The listener that saw
    // the keydown has to be the one that gets the keyup, or the peek sticks.
    setPrivacyDictionary(buildNameDictionary({ names: ['John Smith'] }), { ready: true });
    const html = buildEmailIframeHtml({ bodyHtml: '<p>John Smith</p>', privacy: true });
    const { container } = render(<Frame html={html} />);
    const iframe = container.querySelector('iframe');
    act(() => writeFrame(iframe, html));
    const doc = iframe.contentDocument;
    const key = (type) => doc.dispatchEvent(new doc.defaultView.KeyboardEvent(type, { key: 'Alt', bubbles: true }));
    act(() => { key('keydown'); vi.advanceTimersByTime(300); });
    expect(usePrivacyStore.getState().peek).toBe(true);
    expect(doc.body.textContent).toContain('John Smith');
    act(() => key('keyup'));
    expect(usePrivacyStore.getState().peek).toBe(false);
    expect(doc.body.textContent).not.toContain('John');
  });
  it('a remounted frame with the same srcDoc is masked and revealed too', () => {
    // Same html, new <iframe> element: nothing in the deps changed but the frame.
    setPrivacyDictionary(buildNameDictionary({ names: ['John Smith'] }), { ready: true });
    const html = buildEmailIframeHtml({ bodyHtml: '<p>John Smith</p>', privacy: true });
    const { container, rerender } = render(<Frame html={html} />);
    act(() => writeFrame(container.querySelector('iframe'), html));
    rerender(<Frame html={html} show={false} />);
    rerender(<Frame html={html} />);
    const iframe = container.querySelector('iframe');
    act(() => writeFrame(iframe, html));
    expect(iframe.contentDocument.getElementById(PRIVACY_GATE_ID)).toBeNull();
    expect(iframe.contentDocument.body.textContent).not.toContain('John');
  });
  it('search never marks a held frame, so no name or address is split past the mask; it paints after release', () => {
    setPrivacyDictionary(EMPTY_DICTIONARY, { ready: false });
    useSearchStore.setState({ searchActive: true, searchQuery: 'smi acme hello' });
    const html = buildEmailIframeHtml({ bodyHtml: '<p>John Smith jane@acme.com hello</p>', privacy: true });
    const { container } = render(<SearchFrame html={html} />);
    const iframe = container.querySelector('iframe');
    act(() => writeFrame(iframe, html));
    const doc = iframe.contentDocument;
    expect(applySearchHighlight(doc, ['smi'])).toBe(0);
    expect(applySearchHighlight(doc, ['acme'])).toBe(0);
    expect(doc.querySelectorAll('mark')).toHaveLength(0);
    act(() => setPrivacyDictionary(buildNameDictionary({ names: ['John Smith'] }), { ready: true }));
    act(() => vi.advanceTimersByTime(3200));
    expect(doc.getElementById(PRIVACY_GATE_ID)).toBeNull();
    expect(doc.body.textContent).not.toMatch(/Smith|jane@acme\.com/);
    const marks = [...doc.querySelectorAll('mark.mv-search-hit')].map(m => m.textContent);
    expect(marks).toEqual(['hello']);
  });
  it("masks the frame's own parties after the hold even when the global dictionary never arrives", () => {
    setPrivacyDictionary(EMPTY_DICTIONARY, { ready: false });
    const message = { uid: 1, from: { name: 'John Smith', address: 'j@x.com' }, to: [] };
    const html = buildEmailIframeHtml({ bodyHtml: '<p>John Smith</p>', privacy: true });
    const { container } = render(<SearchFrame html={html} message={message} />);
    const iframe = container.querySelector('iframe');
    act(() => writeFrame(iframe, html));
    act(() => vi.advanceTimersByTime(3200));
    expect(iframe.contentDocument.getElementById(PRIVACY_GATE_ID)).toBeNull();
    expect(iframe.contentDocument.body.textContent).not.toMatch(/John|Smith/);
  });
  it('fails closed: a pass that throws puts the gate back and logs once', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    // A dictionary missing its sets makes the redaction itself throw.
    setPrivacyDictionary({ fullNames: null, tokens: null, unspaced: null, unspacedMax: 0, size: 1 }, { ready: true });
    const html = buildEmailIframeHtml({ bodyHtml: '<p>John Smith</p>', privacy: true });
    const { container } = render(<Frame html={html} />);
    const iframe = container.querySelector('iframe');
    act(() => writeFrame(iframe, html));
    const doc = iframe.contentDocument;
    expect(doc.getElementById(PRIVACY_GATE_ID)).not.toBeNull();
    expect(doc.documentElement.style.getPropertyPriority('opacity')).toBe('important');
    act(() => iframe.dispatchEvent(new Event('load')));
    expect(error).toHaveBeenCalledTimes(1);
    act(() => setPrivacyDictionary(buildNameDictionary({ names: ['John Smith'] }), { ready: true }));
    expect(doc.getElementById(PRIVACY_GATE_ID)).toBeNull();
    expect(doc.body.textContent).not.toMatch(/John|Smith/);
  });
});

describe('usePrivacyFrameGate', () => {
  function Probe({ out }) { out.gate = usePrivacyFrameGate(); return null; }
  it('gates while privacy is on, peeking or not, and not for a capture alone', () => {
    const out = {};
    render(<Probe out={out} />);
    expect(out.gate).toBe(true);
    act(() => usePrivacyStore.setState({ peek: true }));
    expect(out.gate).toBe(true); // a peek must not reload the frame
    act(() => usePrivacyStore.setState({ enabled: false, peek: false, captureMask: true }));
    expect(out.gate).toBe(false); // a capture masks in place; a reload would blank it
    act(() => usePrivacyStore.setState({ captureMask: false }));
    expect(out.gate).toBe(false);
  });
  it('gates in the main window too until the persisted choice has loaded', () => {
    let hydrated = false;
    const listeners = [];
    vi.spyOn(usePrivacyStore.persist, 'hasHydrated').mockImplementation(() => hydrated);
    vi.spyOn(usePrivacyStore.persist, 'onFinishHydration').mockImplementation((cb) => { listeners.push(cb); return () => {}; });
    usePrivacyStore.setState({ enabled: false });
    const out = {};
    render(<Probe out={out} />);
    expect(out.gate).toBe(true);
    hydrated = true;
    act(() => listeners.forEach(l => l()));
    expect(out.gate).toBe(false);
  });
});
