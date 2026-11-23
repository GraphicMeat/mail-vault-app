// @vitest-environment jsdom
// The viewer's keep toggle: the open message goes into the phone's kept-email dock, and out again.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../transport.js', () => ({
  daemonCall: vi.fn(async (method) => {
    if (method !== 'mobile.message.body') throw Object.assign(new Error(method), { code: 'UNSUPPORTED' });
    return { html: '<p>Hi</p>', text: null, attachments: [], remoteImages: 0, trackers: 0, gone: false };
  }),
  listen: vi.fn(() => () => {}),
  openFile: vi.fn(async () => {}),
  shareFile: vi.fn(async () => {}),
}));

const { default: Viewer } = await import('../Viewer.jsx');
const { useKeepStore } = await import('../keep.js');

const row = {
  uid: 7, subject: 'Weekly digest', fromName: 'Ada Lovelace', fromAddress: 'ada@example.test',
  to: [], dateMs: Date.UTC(2026, 10, 3, 10, 0), snippet: '', seen: false, flagged: false, hasAttachments: false,
};
const toggle = () => document.querySelector('[data-mv-keep]');

beforeEach(() => { localStorage.clear(); useKeepStore.setState({ items: [] }); });
afterEach(cleanup);

describe('phone keep button', () => {
  it('the phone viewer keeps the open message', async () => {
    render(<Viewer accountId="a1" folder="INBOX" row={row} onClose={() => {}} />);
    await waitFor(() => expect(toggle()).toBeTruthy());
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(toggle());
    expect(useKeepStore.getState().items[0]).toMatchObject({
      accountId: 'a1', mailbox: 'INBOX', uid: 7, subject: 'Weekly digest',
      sender: { name: 'Ada Lovelace', address: 'ada@example.test' },
    });
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
  });

  it('tapping again removes it', async () => {
    render(<Viewer accountId="a1" folder="INBOX" row={row} onClose={() => {}} />);
    await waitFor(() => expect(toggle()).toBeTruthy());
    fireEvent.click(toggle());
    fireEvent.click(toggle());
    expect(useKeepStore.getState().items).toEqual([]);
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
  });

  it('the tracker shield and keep stay together at the trailing edge', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/mobile/mobile.css'), 'utf8');
    // One auto margin on the first tool after Back; one on the keep button alone would strand the shield.
    expect(css).toMatch(/\.mv-viewer__bar\s*>\s*\.mv-viewer__back\s*\+\s*\*\s*\{[^}]*margin-inline-start:\s*auto/);
    expect(css).not.toMatch(/\[data-mv-keep\]\s*\{\s*margin-inline-start/);
  });
});
