// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ThreadView } from '../email/ThreadView';
import { useSettingsStore } from '../../stores/settingsStore';
import { useMailStore } from '../../stores/mailStore';

// Keep the real virtualizer: fixed-position stubs cannot catch overlapping rows.
// Only browser geometry is simulated. An expanded message has the same height
// in Timeline and Compact, so ResizeObserver does NOT announce it a second time.
vi.mock('../../hooks/useChatBodyLoader', async () => {
  const { emailKey } = await import('../../stores/slices/unifiedHelpers');
  return { emailKey, useChatBodyLoader: emails => ({
    bodiesMapRef: { current: new Map(emails.map(email => [emailKey(email), { status: 'loaded', email }])) },
    registerListener: () => () => {},
  }) };
});
vi.mock('../email/EmailActionBar', () => ({ EmailActionBar: () => null }));

const emails = Array.from({ length: 4 }, (_, i) => ({
  uid: i + 1, _accountId: 'layout', _mailbox: 'INBOX', subject: `Message ${i + 1}`,
  from: { name: `Sender ${i + 1}`, address: `sender${i + 1}@example.test` },
  to: [{ address: 'me@example.test' }], date: `2026-09-0${i + 1}`, text: 'A complete message body.', attachments: [],
}));
const thread = { threadId: 'layout', subject: 'Conversation', emails, messageCount: emails.length };
let observers;
let expandedHeight;
function heightOf(node) {
  if (!node.hasAttribute('data-index')) return 600;
  if (node.querySelector('.email-content')) return expandedHeight;
  return node.querySelector('[data-testid="header-toggle"]') ? 96 : 56;
}
function bounds(node) {
  const height = heightOf(node);
  const top = Number(node.style.transform.match(/translateY\(([-.\d]+)px\)/)?.[1] || 0);
  return { x: 0, y: top, top, bottom: top + height, left: 0, right: 800, height, width: 800, toJSON() {} };
}
// Deliver only initial observations or actual size changes, as a browser does.
function resize() {
  act(() => {
    for (const observer of observers) {
      const entries = [];
      for (const [node, previous] of observer.nodes) {
        const height = heightOf(node);
        if (previous === height) continue;
        observer.nodes.set(node, height);
        entries.push({ target: node, borderBoxSize: [{ inlineSize: 800, blockSize: height }] });
      }
      if (entries.length) observer.callback(entries);
    }
  });
}
function assertNoOverlap() {
  const rows = [...document.querySelectorAll('.thread-reader-content [data-index]')];
  expect(rows).toHaveLength(emails.length);
  for (let index = 1; index < rows.length; index++) {
    const previous = bounds(rows[index - 1]);
    const current = bounds(rows[index]);
    expect(current.top, `message ${index + 1} must start below message ${index}`).toBeGreaterThanOrEqual(previous.bottom);
  }
}
function choose(layout) {
  fireEvent.change(screen.getByLabelText('Layout'), { target: { value: layout } });
  resize();
  assertNoOverlap();
}

beforeEach(() => {
  observers = new Set();
  expandedHeight = 480;
  vi.stubGlobal('ResizeObserver', class {
    nodes = new Map();
    constructor(callback) { this.callback = callback; observers.add(this); }
    observe(node) { if (!this.nodes.has(node)) this.nodes.set(node, null); }
    unobserve(node) { this.nodes.delete(node); }
    disconnect() { this.nodes.clear(); }
  });
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 0));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () { return bounds(this); });
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function () { return heightOf(this); });
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(800);
  useSettingsStore.setState({ threadReaderLayout: 'timeline', threadSortOrder: 'oldest-first', signatureDisplay: 'always-show', emailViewerTheme: 'dark' });
  useMailStore.setState({ activeAccountId: 'layout', activeMailbox: 'INBOX', accounts: [{ id: 'layout', email: 'me@example.test' }], emails, sortedEmails: emails });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('keeps an unchanged expanded message measured when switching between layouts', () => {
  render(<ThreadView thread={thread} />);
  resize();
  fireEvent.click(screen.getAllByTestId('thread-email-header')[1]);
  resize();
  assertNoOverlap();
  choose('compact');
  choose('timeline');
  choose('split');
  choose('compact');
  choose('timeline');
});

it('continues measuring body growth and sort changes after a layout switch', () => {
  render(<ThreadView thread={thread} />);
  resize();
  fireEvent.click(screen.getAllByTestId('thread-email-header')[0]);
  resize();
  choose('compact');
  expandedHeight = 900;
  resize();
  assertNoOverlap();
  act(() => useSettingsStore.getState().setThreadSortOrder('newest-first'));
  resize();
  assertNoOverlap();
});
