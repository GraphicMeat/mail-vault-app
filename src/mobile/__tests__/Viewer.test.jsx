// @vitest-environment jsdom
// The viewer: the header straight from the list row, then the body from `mobile.message.body` in a
// sandboxed frame that can neither run script nor reach the app's origin.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react';
import { t } from '../i18n.js';

const engine = vi.hoisted(() => ({ calls: [], reply: null }));

vi.mock('../transport.js', () => ({
  daemonCall: vi.fn(async (method, params = {}) => {
    engine.calls.push([method, params]);
    if (method !== 'mobile.message.body') throw Object.assign(new Error(method), { code: 'UNSUPPORTED' });
    const r = typeof engine.reply === 'function' ? engine.reply(params) : engine.reply;
    if (r instanceof Error) throw r;
    return r;
  }),
}));

const { default: Viewer } = await import('../Viewer.jsx');

const SANDBOX = 'allow-popups allow-popups-to-escape-sandbox';

const row = {
  uid: 7, subject: 'Weekly digest', fromName: 'Ada Lovelace', fromAddress: 'ada@example.test',
  to: [{ name: 'Grace Hopper', address: 'grace@example.test' }, { name: '', address: 'linus@example.test' }],
  dateMs: Date.UTC(2026, 10, 3, 10, 0), snippet: '', seen: false, flagged: false, hasAttachments: true,
};

const body = (over = {}) => ({
  html: '<p>Hello <img src="https://img.test/a.png"></p>', text: null, attachments: [],
  remoteImages: 0, trackers: 0, gone: false, ...over,
});

const renderViewer = (props = {}) =>
  render(<Viewer accountId="a1" folder="INBOX" row={row} onClose={() => {}} {...props} />);

const frame = () => document.querySelector('iframe');

beforeEach(() => { engine.calls = []; engine.reply = body(); });
afterEach(cleanup);

describe('Viewer', () => {
  it('frame_has_no_same_origin_or_scripts', async () => {
    renderViewer();
    await waitFor(() => expect(frame()).toBeTruthy());
    const f = frame();
    expect(f.getAttribute('sandbox')).toBe(SANDBOX);
    expect(f.getAttribute('sandbox')).not.toMatch(/allow-same-origin|allow-scripts/);
    expect(f.getAttribute('title')).toBe(t('mobile.viewer.frameTitle'));
    expect(f.hasAttribute('src')).toBe(false);
    expect(f.getAttribute('srcdoc')).toContain('<meta http-equiv="Content-Security-Policy"');
    expect(engine.calls).toEqual([['mobile.message.body', { accountId: 'a1', folder: 'INBOX', uid: 7 }]]);
  });

  it('shows the header from the row before the body arrives', async () => {
    let resolve;
    engine.reply = () => new Promise((r) => { resolve = r; });
    renderViewer();
    expect(screen.getByRole('heading', { name: 'Weekly digest' })).toBeTruthy();
    expect(screen.getByText('Ada Lovelace')).toBeTruthy();
    expect(screen.getByText('ada@example.test')).toBeTruthy();
    expect(screen.getByText('Grace Hopper, linus@example.test')).toBeTruthy();
    expect(screen.getByText(t('common.from'))).toBeTruthy();
    expect(screen.getByText(t('common.to'))).toBeTruthy();
    expect(document.querySelector('time').getAttribute('datetime')).toBe(new Date(row.dateMs).toISOString());
    expect(screen.getByRole('status').textContent).toBe(t('mobile.viewer.loading'));
    expect(frame()).toBeNull();
    await act(async () => { resolve(body()); });
    expect(frame()).toBeTruthy();
  });

  it('gone_message_shows_notice', async () => {
    engine.reply = body({ html: null, gone: true });
    renderViewer();
    await waitFor(() => expect(screen.getByText(t('mobile.viewer.gone'))).toBeTruthy());
    expect(frame()).toBeNull();
    expect(screen.getByRole('heading', { name: 'Weekly digest' })).toBeTruthy();
  });

  it('load_images_rebuilds_with_remote', async () => {
    engine.reply = body({ remoteImages: 3 });
    renderViewer();
    await waitFor(() => expect(frame()).toBeTruthy());
    const before = frame();
    expect(before.getAttribute('srcdoc')).toContain("img-src data: cid:;");
    expect(before.getAttribute('srcdoc')).not.toContain('https:;');
    const button = screen.getByRole('button', { name: t('mobile.viewer.loadImages', { count: 3 }) });
    expect(button.textContent).toBe('Load images (3)');
    expect(parseInt(getComputedStyle(button).minHeight, 10) || parseInt(button.style.minHeight, 10)).toBeGreaterThanOrEqual(44);
    fireEvent.click(button);
    const after = frame();
    expect(after.getAttribute('srcdoc')).toContain('img-src data: cid: https:;');
    // A new frame, not a second srcdoc write into the one still loading.
    expect(after).not.toBe(before);
    expect(after.getAttribute('sandbox')).toBe(SANDBOX);
    expect(screen.queryByRole('button', { name: t('mobile.viewer.loadImages', { count: 3 }) })).toBeNull();
    expect(engine.calls).toHaveLength(1);
  });

  it('no load-images bar when nothing remote is in the mail', async () => {
    renderViewer();
    await waitFor(() => expect(frame()).toBeTruthy());
    expect(screen.queryByRole('button', { name: /Load image/ })).toBeNull();
  });

  it('a text body goes into the frame escaped', async () => {
    engine.reply = body({ html: null, text: '<b>not bold</b> https://example.test/' });
    renderViewer();
    await waitFor(() => expect(frame()).toBeTruthy());
    const doc = frame().getAttribute('srcdoc');
    expect(doc).toContain('&lt;b&gt;not bold&lt;/b&gt;');
    expect(doc).toContain('<a href="https://example.test/" rel="noopener noreferrer">');
  });

  it('lists attachments as static chips with name and size', async () => {
    engine.reply = body({
      html: '<p>See <img src="cid:logo@x"></p>',
      attachments: [
        { section: '2', filename: 'report.pdf', mime: 'application/pdf', size: 245760, contentId: null },
        { section: '3', filename: null, mime: 'image/png', size: 512, contentId: null },
        { section: '4', filename: 'logo.png', mime: 'image/png', size: 900, contentId: '<logo@x>' },
      ],
    });
    renderViewer();
    // Every part is a chip, an inline `cid:` image too: the frame does not draw those yet.
    const list = await screen.findByRole('list', { name: t('common.attachmentCount', { count: 3 }) });
    const items = list.querySelectorAll('li');
    expect(items).toHaveLength(3);
    expect(items[0].textContent).toContain('report.pdf');
    expect(items[0].textContent).toMatch(/240 kB|240 KB/);
    expect(items[1].textContent).toContain(t('mobile.viewer.attachment'));
    expect(items[2].textContent).toContain('logo.png');
    // Static in this slice: nothing to tap yet.
    expect(list.querySelector('button, a')).toBeNull();
  });

  it('an error shows the reason and retries', async () => {
    engine.reply = Object.assign(new Error('HOST_UNREACHABLE'), { code: 'INTERNAL' });
    renderViewer();
    const alert = await screen.findByRole('alert');
    // One sentence from one key, the reason interpolated: no two strings glued by a space.
    expect(alert.querySelector('p').textContent).toBe(t('mobile.viewer.loadFailed', { reason: t('mobile.error.HOST_UNREACHABLE') }));
    expect(alert.querySelector('p').textContent).toContain(t('mobile.error.HOST_UNREACHABLE'));
    expect(alert.querySelector('p').textContent).not.toContain('{{');
    engine.reply = body();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: t('common.retry') })); });
    await waitFor(() => expect(frame()).toBeTruthy());
    expect(engine.calls).toHaveLength(2);
  });

  it('ignores a reply that lands after the viewer closed', async () => {
    let resolve;
    engine.reply = () => new Promise((r) => { resolve = r; });
    const { unmount } = renderViewer();
    unmount();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await act(async () => { resolve(body()); });
    expect(err).not.toHaveBeenCalled();
    err.mockRestore();
  });

  it('has a back control at least 44px tall that closes, marked for the perf probe', () => {
    const onClose = vi.fn();
    renderViewer({ onClose });
    const back = screen.getByRole('button', { name: t('common.back') });
    expect(back.hasAttribute('data-mv-viewer-close')).toBe(true);
    expect(parseInt(back.style.minHeight, 10)).toBeGreaterThanOrEqual(44);
    fireEvent.click(back);
    expect(onClose).toHaveBeenCalled();
  });
});
