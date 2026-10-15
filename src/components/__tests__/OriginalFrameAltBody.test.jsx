// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
vi.mock('../../utils/emailIframeTemplate', async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, attachEmailIframeAutoSize: vi.fn(real.attachEmailIframeAutoSize) };
});
const { OriginalFrame, buildOriginalFrameHtml } = await import('../OriginalFrame');
const { buildEmailIframeHtml, attachEmailIframeAutoSize } = await import('../../utils/emailIframeTemplate');
const { frameBody } = await import('../../stores/netActivityStore');
const { getDarkReaderInlineScripts } = await import('../../utils/darkReaderInject');
const { registerBodyRenderer, _resetBodyRenderersForTest } = await import('../email/bodyRendererRegistry');
const { useSettingsStore } = await import('../../stores/settingsStore');
const { useThemeStore } = await import('../../stores/themeStore');

const seen = [];
const Stub = (p) => { seen.push(p); return <div data-testid="alt-original" />; };
const unNonce = (s) => s.replace(/nonce-[A-Za-z0-9]+/g, 'nonce-N').replace(/nonce="[A-Za-z0-9]+"/g, 'nonce="N"');
beforeEach(() => { useThemeStore.setState({ palette: 'graphite' }); });
afterEach(() => { cleanup(); seen.length = 0; vi.mocked(attachEmailIframeAutoSize).mockClear(); _resetBodyRenderersForTest(); useSettingsStore.setState({ emailRenderer: 'web' }); });

describe('OriginalFrame on the body seam', () => {
  it('Blitz gets the srcdoc the iframe gets, padding included', () => {
    const { container, unmount } = render(<OriginalFrame html="<p>Quoted</p>" dark title="t" message={{ messageId: '<q@x>' }} />);
    const srcdoc = container.querySelector('iframe').getAttribute('srcdoc');
    unmount();
    registerBodyRenderer('blitz', { Body: Stub });
    useSettingsStore.setState({ emailRenderer: 'blitz' });
    const v = render(<OriginalFrame html="<p>Quoted</p>" dark title="t" message={{ messageId: '<q@x>' }} />);
    expect(v.container.querySelector('iframe')).toBeNull();
    const p = seen.at(-1);
    expect(unNonce(p.documentHtml)).toBe(unNonce(srcdoc));
    expect(p.documentHtml).toContain('<style>body { padding: 12px 16px; }</style>');
    expect(p).toMatchObject({ surface: 'original', messageKey: '<q@x>', theme: { dark: true, palette: 'graphite' }, sizing: 'content', foldQuotes: false });
    expect(p.onLink).toBeUndefined();
  });

  it('no message id: no invented messageKey (BlitzBody derives its own)', () => {
    registerBodyRenderer('blitz', { Body: Stub });
    useSettingsStore.setState({ emailRenderer: 'blitz' });
    render(<OriginalFrame html="<p>Q</p>" dark={false} title="t" />);
    expect(seen.at(-1).messageKey).toBeUndefined();
  });

  it('pop-out: no padding override and fills', () => {
    registerBodyRenderer('blitz', { Body: Stub });
    useSettingsStore.setState({ emailRenderer: 'blitz' });
    render(<OriginalFrame html="<p>Q</p>" dark={false} title="t" surface="popout" padding={null} autoSize={false} />);
    const p = seen.at(-1);
    expect(p.surface).toBe('popout');
    expect(p.sizing).toBe('fill');
    expect(p.documentHtml).not.toContain('<style>body { padding:');
  });

  it('buildOriginalFrameHtml with padding null adds no override', () => {
    expect(buildOriginalFrameHtml({ html: '<p>x</p>', dark: false, palette: 'graphite', padding: null, trackerBlocking: false, privacy: false, nonce: 'n' })).not.toContain('<style>body { padding:');
  });

  it('buildOriginalFrameHtml is byte-identical to the template the component built inline', () => {
    // The pre-extraction body of the srcDoc memo, verbatim.
    const old = ({ html, dark, palette, padding, trackerBlocking, privacy, nonce }) => buildEmailIframeHtml({
      bodyHtml: frameBody(html, null, trackerBlocking).body,
      themeTag: dark ? 'dark' : 'light',
      extraHead: `${dark ? getDarkReaderInlineScripts({ palette, nonce }) : ''}<style>body { padding: ${padding}; }</style>`,
      nonce,
      privacy,
    });
    const html = '<div style="color:#123">Hi <a href="https://example.com/x">there</a></div><img src="https://t.example/p.gif" width="1" height="1">';
    for (const dark of [false, true]) for (const trackerBlocking of [false, true]) for (const privacy of [false, true]) for (const padding of ['12px 16px', '0']) {
      const args = { html, dark, palette: 'indigo', padding, trackerBlocking, privacy, nonce: 'abc123' };
      expect(buildOriginalFrameHtml(args)).toBe(old(args));
    }
  });

  it('switching blitz to web attaches the auto-size to the fresh iframe', () => {
    registerBodyRenderer('blitz', { Body: Stub });
    useSettingsStore.setState({ emailRenderer: 'blitz' });
    const { container } = render(<OriginalFrame html="<p>Q</p>" dark={false} title="t" />);
    expect(container.querySelector('iframe')).toBeNull();
    expect(vi.mocked(attachEmailIframeAutoSize).mock.calls.every(([f]) => !f)).toBe(true);
    act(() => { useSettingsStore.setState({ emailRenderer: 'web' }); });
    const frame = container.querySelector('iframe');
    expect(frame).not.toBeNull();
    expect(vi.mocked(attachEmailIframeAutoSize).mock.calls.some(([f]) => f === frame)).toBe(true);
  });
});
