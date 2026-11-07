// @vitest-environment jsdom
// An attachment chip: idle (name, size), downloading (progress from the engine's events, tap
// cancels), ready (tap opens, long press shares, always with the path the engine just gave), failed
// (translated reason, tap retries). Events may arrive before the `{jobId}` reply.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react';
import { t } from '../i18n.js';
import { formatSize } from '../format.js';

const engine = vi.hoisted(() => ({
  calls: [],
  shell: [],
  listeners: new Map(),
  local: null,
  fetch: null,
  shellReply: null,
}));

vi.mock('../transport.js', () => {
  class DaemonError extends Error {
    constructor(message, code) { super(message); this.code = code; }
  }
  const answer = async (r, args) => {
    const v = typeof r === 'function' ? await r(args) : r;
    if (v instanceof Error) throw v;
    return v;
  };
  return {
    DaemonError,
    daemonCall: vi.fn(async (method, params = {}) => {
      engine.calls.push([method, params]);
      if (method === 'mobile.attachment.local') return answer(engine.local, params);
      if (method === 'mobile.attachment.fetch') return answer(engine.fetch, params);
      if (method === 'mobile.attachment.cancel') return { cancelled: true };
      throw new DaemonError(method, 'UNSUPPORTED');
    }),
    listen: vi.fn((name, handler) => {
      if (!engine.listeners.has(name)) engine.listeners.set(name, new Set());
      engine.listeners.get(name).add(handler);
      return () => engine.listeners.get(name).delete(handler);
    }),
    openFile: vi.fn(async (args) => { engine.shell.push(['mobile_open_file', args]); return answer(engine.shellReply, args); }),
    shareFile: vi.fn(async (args) => { engine.shell.push(['mobile_share_file', args]); return answer(engine.shellReply, args); }),
  };
});

const jobs = await import('../attachmentJobs.js');
const { default: AttachmentChip, LONG_PRESS_MS } = await import('../AttachmentChip.jsx');

const PATH = '/cache/att/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const pdf = { section: '2', filename: 'Planting calendar 2027.pdf', mime: 'application/pdf', size: 245760, contentId: null };
const key = { accountId: 'a1', folder: 'INBOX', uid: 7, section: '2' };

function emit(name, payload) {
  act(() => { for (const h of engine.listeners.get(name) || []) h(payload); });
}

const renderChip = (attachment = pdf) =>
  render(<ul><AttachmentChip accountId="a1" folder="INBOX" uid={7} attachment={attachment} /></ul>);

const chip = () => screen.getByRole('button');
const calls = (method) => engine.calls.filter(([m]) => m === method).map(([, p]) => p);

beforeEach(() => {
  jobs.resetAttachmentJobs();
  engine.calls = [];
  engine.shell = [];
  engine.listeners = new Map();
  engine.local = { path: null };
  engine.fetch = { jobId: 41 };
  engine.shellReply = null;
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('AttachmentChip', () => {
  it('idle_shows_name_and_size', async () => {
    renderChip();
    await waitFor(() => expect(calls('mobile.attachment.local')).toEqual([key]));
    expect(chip().textContent).toContain('Planting calendar 2027.pdf');
    expect(chip().textContent).toMatch(/240 kB|240 KB/);
    expect(chip().getAttribute('data-mv-attachment-state')).toBe('idle');
    expect(chip().getAttribute('aria-label')).toBe(t('mobile.attachment.labelIdle', { name: pdf.filename, size: formatSize(pdf.size) }));
  });

  it('a_cached_file_starts_ready', async () => {
    engine.local = { path: PATH };
    renderChip();
    await waitFor(() => expect(chip().getAttribute('data-mv-attachment-state')).toBe('ready'));
  });

  it('chip_shows_progress_from_events', async () => {
    renderChip();
    await waitFor(() => expect(calls('mobile.attachment.local')).toHaveLength(1));
    // The progress event lands before the fetch reply: it is kept for job 41.
    let release;
    engine.fetch = () => new Promise((r) => { release = r; });
    fireEvent.click(chip());
    expect(chip().getAttribute('data-mv-attachment-state')).toBe('downloading');
    emit('mobile.attachment.progress', { jobId: 41, received: 61440, total: 245760 });
    emit('mobile.attachment.progress', { jobId: 99, received: 1, total: 2 });
    await act(async () => { release({ jobId: 41 }); });
    expect(calls('mobile.attachment.fetch')).toEqual([key]);
    const ring = chip().querySelector('[data-mv-progress]');
    expect(ring.getAttribute('data-mv-progress')).toBe('0.25');
    expect(chip().textContent).toContain('25');
    emit('mobile.attachment.progress', { jobId: 41, received: 122880, total: 245760 });
    expect(chip().querySelector('[data-mv-progress]').getAttribute('data-mv-progress')).toBe('0.5');
    expect(chip().getAttribute('aria-label')).toContain('50');
    emit('mobile.attachment.done', { jobId: 41, path: PATH });
    expect(chip().getAttribute('data-mv-attachment-state')).toBe('ready');
  });

  it('tap_while_downloading_cancels', async () => {
    renderChip();
    await waitFor(() => expect(calls('mobile.attachment.local')).toHaveLength(1));
    await act(async () => { fireEvent.click(chip()); });
    await waitFor(() => expect(calls('mobile.attachment.fetch')).toHaveLength(1));
    emit('mobile.attachment.progress', { jobId: 41, received: 10, total: 245760 });
    await act(async () => { fireEvent.click(chip()); });
    expect(calls('mobile.attachment.cancel')).toEqual([{ jobId: 41 }]);
    expect(chip().getAttribute('data-mv-attachment-state')).toBe('idle');
    // The engine's own end of the job changes nothing more.
    emit('mobile.attachment.failed', { jobId: 41, code: 'CANCELLED' });
    expect(chip().getAttribute('data-mv-attachment-state')).toBe('idle');
    expect(screen.queryByText(t('mobile.attachment.error.internal'))).toBeNull();
  });

  it('a_cancel_before_the_reply_cancels_the_job_it_names', async () => {
    renderChip();
    await waitFor(() => expect(calls('mobile.attachment.local')).toHaveLength(1));
    let release;
    engine.fetch = () => new Promise((r) => { release = r; });
    fireEvent.click(chip());
    fireEvent.click(chip());
    expect(chip().getAttribute('data-mv-attachment-state')).toBe('idle');
    await act(async () => { release({ jobId: 41 }); });
    expect(calls('mobile.attachment.cancel')).toEqual([{ jobId: 41 }]);
    emit('mobile.attachment.done', { jobId: 41, path: PATH });
    expect(chip().getAttribute('data-mv-attachment-state')).toBe('idle');
  });

  it('ready_tap_opens_engine_path_only', async () => {
    engine.local = { path: PATH };
    renderChip();
    await waitFor(() => expect(chip().getAttribute('data-mv-attachment-state')).toBe('ready'));
    // The path is asked for again on the tap: a file evicted meanwhile is fetched, not opened.
    const other = `${PATH.slice(0, -1)}0`;
    engine.local = { path: other };
    await act(async () => { fireEvent.click(chip()); });
    expect(engine.shell).toEqual([['mobile_open_file', { path: other, name: pdf.filename, mime: 'application/pdf' }]]);
    expect(calls('mobile.attachment.local')).toHaveLength(2);
    // Nothing of the message's own metadata is ever passed as a path.
    expect(JSON.stringify(engine.shell)).not.toContain('/cache/att/x');
  });

  it('ready_with_a_purged_file_fetches_again', async () => {
    engine.local = { path: PATH };
    renderChip();
    await waitFor(() => expect(chip().getAttribute('data-mv-attachment-state')).toBe('ready'));
    engine.local = { path: null };
    await act(async () => { fireEvent.click(chip()); });
    expect(engine.shell).toEqual([]);
    expect(calls('mobile.attachment.fetch')).toEqual([key]);
    expect(chip().getAttribute('data-mv-attachment-state')).toBe('downloading');
  });

  it('a_gone_answer_from_the_shell_fetches_again', async () => {
    engine.local = { path: PATH };
    renderChip();
    await waitFor(() => expect(chip().getAttribute('data-mv-attachment-state')).toBe('ready'));
    engine.shellReply = Object.assign(new Error('the file is gone'), { code: 'GONE' });
    await act(async () => { fireEvent.click(chip()); });
    expect(calls('mobile.attachment.fetch')).toEqual([key]);
  });

  it('long_press_shares_and_does_not_open', async () => {
    engine.local = { path: PATH };
    renderChip();
    await waitFor(() => expect(chip().getAttribute('data-mv-attachment-state')).toBe('ready'));
    vi.useFakeTimers();
    fireEvent.pointerDown(chip(), { clientX: 10, clientY: 10 });
    await act(async () => { vi.advanceTimersByTime(LONG_PRESS_MS + 10); });
    fireEvent.pointerUp(chip(), { clientX: 10, clientY: 10 });
    fireEvent.click(chip());
    vi.useRealTimers();
    await waitFor(() => expect(engine.shell).toHaveLength(1));
    expect(engine.shell[0]).toEqual(['mobile_share_file', { path: PATH, name: pdf.filename, mime: 'application/pdf' }]);
  });

  it('a_short_press_or_a_drag_does_not_share', async () => {
    engine.local = { path: PATH };
    renderChip();
    await waitFor(() => expect(chip().getAttribute('data-mv-attachment-state')).toBe('ready'));
    vi.useFakeTimers();
    fireEvent.pointerDown(chip(), { clientX: 10, clientY: 10 });
    fireEvent.pointerMove(chip(), { clientX: 60, clientY: 10 });
    await act(async () => { vi.advanceTimersByTime(LONG_PRESS_MS + 10); });
    vi.useRealTimers();
    expect(engine.shell).toEqual([]);
  });

  it('no_app_keeps_the_chip_ready_and_says_why', async () => {
    engine.local = { path: PATH };
    renderChip();
    await waitFor(() => expect(chip().getAttribute('data-mv-attachment-state')).toBe('ready'));
    engine.shellReply = Object.assign(new Error('no app'), { code: 'NO_APP' });
    await act(async () => { fireEvent.click(chip()); });
    expect(chip().getAttribute('data-mv-attachment-state')).toBe('ready');
    expect(chip().textContent).toContain(t('mobile.attachment.error.noApp'));
  });

  it('failed_shows_retry', async () => {
    renderChip();
    await waitFor(() => expect(calls('mobile.attachment.local')).toHaveLength(1));
    await act(async () => { fireEvent.click(chip()); });
    emit('mobile.attachment.failed', { jobId: 41, code: 'HOST_UNREACHABLE' });
    expect(chip().getAttribute('data-mv-attachment-state')).toBe('failed');
    expect(chip().textContent).toContain(t('mobile.attachment.error.network'));
    expect(chip().getAttribute('aria-label')).toBe(t('mobile.attachment.labelFailed', { name: pdf.filename, reason: t('mobile.attachment.error.network') }));
    engine.fetch = { jobId: 42 };
    await act(async () => { fireEvent.click(chip()); });
    expect(calls('mobile.attachment.fetch')).toHaveLength(2);
    expect(chip().getAttribute('data-mv-attachment-state')).toBe('downloading');
    emit('mobile.attachment.done', { jobId: 42, path: PATH });
    expect(chip().getAttribute('data-mv-attachment-state')).toBe('ready');
  });

  it('every_failure_code_reads_as_a_translated_reason', async () => {
    const cases = {
      HOST_UNREACHABLE: 'network', TIMEOUT: 'network', TLS_FAILED: 'network', AUTH_FAILED: 'auth',
      GONE: 'gone', INVALID: 'storage', INTERNAL: 'internal', SOMETHING_NEW: 'internal',
    };
    for (const [code, reason] of Object.entries(cases)) {
      cleanup();
      jobs.resetAttachmentJobs();
      engine.listeners = new Map();
      engine.fetch = { jobId: 50 };
      renderChip();
      await act(async () => { fireEvent.click(chip()); });
      emit('mobile.attachment.failed', { jobId: 50, code });
      expect(chip().textContent, code).toContain(t(`mobile.attachment.error.${reason}`));
    }
  });

  it('a_fetch_the_engine_refuses_fails_the_chip', async () => {
    engine.fetch = Object.assign(new Error('the folder has not been synced'), { code: 'INVALID' });
    renderChip();
    await act(async () => { fireEvent.click(chip()); });
    expect(chip().getAttribute('data-mv-attachment-state')).toBe('failed');
  });

  it('touch_target_is_44_points', async () => {
    renderChip();
    const css = readFileSync(resolve(process.cwd(), 'src/mobile/mobile.css'), 'utf8');
    expect(css).toMatch(/\.mv-viewer__chip \{[^}]*min-height: 44px/);
    expect(chip().tagName).toBe('BUTTON');
  });
});
