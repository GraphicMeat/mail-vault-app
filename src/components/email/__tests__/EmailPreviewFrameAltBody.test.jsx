// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
vi.mock('../../../services/fontService', async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, attachMailFonts: vi.fn(real.attachMailFonts) };
});
const { EmailPreviewFrame, previewBody, buildEmailPreviewHtml } = await import('../EmailPreviewFrame');
const { buildEmailIframeHtml, getEmailBodyContent } = await import('../../../utils/emailIframeTemplate');
const { frameBody } = await import('../../../stores/netActivityStore');
const { attachMailFonts } = await import('../../../services/fontService');
const { registerBodyRenderer, _resetBodyRenderersForTest } = await import('../bodyRendererRegistry');
const { useSettingsStore } = await import('../../../stores/settingsStore');

const seen = [];
const Stub = (p) => { seen.push(p); return <div data-testid="alt-preview" />; };
afterEach(() => { cleanup(); seen.length = 0; vi.mocked(attachMailFonts).mockClear(); _resetBodyRenderersForTest(); useSettingsStore.setState({ emailRenderer: 'web' }); });

describe('EmailPreviewFrame on the body seam', () => {
  it('draws the same body light, capped at 2000 and scrolling', () => {
    registerBodyRenderer('blitz', { Body: Stub });
    useSettingsStore.setState({ emailRenderer: 'blitz' });
    const html = '<html><body><p>Snapshot</p></body></html>';
    const { container } = render(<EmailPreviewFrame html={html} title="t" message={{ uid: 5, text: 'Snapshot' }} />);
    expect(container.querySelector('iframe')).toBeNull();
    const p = seen.at(-1);
    expect(p.bodyHtml).toBe(previewBody(html, false));
    expect(p).toMatchObject({ surface: 'preview', sizing: { collapsedMax: 2000 }, foldQuotes: false, plainText: 'Snapshot' });
    expect(p.theme.dark).toBe(false);
    expect(p.message.uid).toBe(5);
    expect(p.messageKey).toBeUndefined();
    expect(p.onLink).toBeUndefined();
  });

  it('messageKey is the message id when there is one', () => {
    registerBodyRenderer('blitz', { Body: Stub });
    useSettingsStore.setState({ emailRenderer: 'blitz' });
    render(<EmailPreviewFrame html="<p>x</p>" title="t" message={{ uid: 5, messageId: '<m@x>' }} />);
    expect(seen.at(-1).messageKey).toBe('<m@x>');
  });

  it('buildEmailPreviewHtml is byte-identical to the template built before previewBody was extracted', () => {
    const html = '<!DOCTYPE html><html><head><style>p{color:red}</style></head><body><p>Hi</p><img src="https://t.example/p.gif" width="1" height="1"></body></html>';
    for (const tb of [false, true]) for (const privacy of [false, true]) {
      const old = buildEmailIframeHtml({ bodyHtml: frameBody(getEmailBodyContent(html), null, tb).body, privacy });
      const norm = (s) => s.replace(/nonce-[A-Za-z0-9+/=_-]+/g, 'nonce-N').replace(/nonce="[^"]+"/g, 'nonce="N"');
      expect(norm(buildEmailPreviewHtml(html, tb, privacy))).toBe(norm(old));
    }
  });

  it('switching blitz to web attaches the mail fonts to the fresh iframe', () => {
    registerBodyRenderer('blitz', { Body: Stub });
    useSettingsStore.setState({ emailRenderer: 'blitz' });
    const { container } = render(<EmailPreviewFrame html="<p>x</p>" title="t" />);
    expect(container.querySelector('iframe')).toBeNull();
    expect(vi.mocked(attachMailFonts)).not.toHaveBeenCalled();
    act(() => { useSettingsStore.setState({ emailRenderer: 'web' }); });
    const frame = container.querySelector('iframe');
    expect(frame).not.toBeNull();
    expect(vi.mocked(attachMailFonts).mock.calls.some(([f]) => f === frame)).toBe(true);
  });
});
