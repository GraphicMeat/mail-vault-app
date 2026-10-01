// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { useRef } from 'react';
import { render, act, cleanup } from '@testing-library/react';
import { useBodyPrivacy } from '../useBodyPrivacy';
import { usePrivacyStore } from '../../stores/privacyStore';
import { setPrivacyDictionary } from '../../utils/privacy/privacyDictionary';
import { buildNameDictionary, EMPTY_DICTIONARY } from '../../utils/privacy/piiDetector';
import { buildEmailIframeHtml } from '../../utils/emailIframeTemplate';
import { PRIVACY_GATE_ID } from '../../utils/iframePrivacyRedact';

// jsdom does not load srcdoc, so the test frame's document is written by hand.
function Frame({ html }) {
  const ref = useRef(null);
  useBodyPrivacy(ref, html, { readyTimeoutMs: 3000 });
  return <iframe ref={ref} title="t" />;
}
function writeFrame(iframe, html) {
  const d = iframe.contentDocument; d.open(); d.write(html); d.close();
  iframe.dispatchEvent(new Event('load'));
}

beforeEach(() => { vi.useFakeTimers(); usePrivacyStore.setState({ enabled: true, peek: false, captureMask: false }); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

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
});
