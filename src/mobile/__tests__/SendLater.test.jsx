// @vitest-environment jsdom
// The send-later sheet's clock: the morning choice never lands past a day (07:50 to 08:00), the
// open sheet re-reads the clock so its choices never go stale, and the outbox moves a scheduled
// row out of "Scheduled" once its time passed while the sheet stayed open.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';

vi.mock('../transport.js', () => ({
  daemonCall: vi.fn(async () => ({})),
  listen: vi.fn(() => () => {}),
}));

const { default: SendLater, nextMorning, scheduleChoices, timeProblem, MAX_DELAY_MS, SHEET_TICK_MS } = await import('../SendLater.jsx');
const { OutboxSheet } = await import('../Outbox.jsx');
const { useMobileStore } = await import('../store.js');
const { t } = await import('../i18n.js');

const at = (h, m) => new Date(2027, 2, 10, h, m, 0, 0).getTime();

beforeEach(() => {
  useMobileStore.setState({ premium: { premium: true, source: 'apple', expiresMs: Date.now() + 1e10 } });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('the morning choice', () => {
  it('is today 08:00 when that is more than 10 minutes away, else tomorrow 08:00', () => {
    expect(nextMorning(at(6, 0))).toBe(at(8, 0));
    expect(nextMorning(at(7, 49))).toBe(at(8, 0));
    expect(nextMorning(at(9, 0))).toBe(new Date(2027, 2, 11, 8, 0, 0, 0).getTime());
  });

  it('never lands more than a day ahead, so it is never refused as too far', () => {
    for (const now of [at(7, 50), at(7, 55), at(7, 59)]) {
      const m = nextMorning(now);
      expect(m).toBe(at(8, 0));
      expect(timeProblem(m, now)).toBeNull();
    }
    for (let minute = 0; minute < 24 * 60; minute += 1) {
      const now = at(0, 0) + minute * 60_000;
      const morning = scheduleChoices(now).find((c) => c.id === 'morning').at;
      expect(morning - now, new Date(now).toTimeString()).toBeLessThanOrEqual(MAX_DELAY_MS);
      expect(morning, new Date(now).toTimeString()).toBeGreaterThan(now);
    }
  });
});

describe('an open sheet', () => {
  it('takes a ready choice from the clock at the tap, not when the sheet opened', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(at(10, 0));
    const onPick = vi.fn();
    render(<SendLater title="Send later" onPick={onPick} onClose={() => {}} />);
    act(() => { vi.advanceTimersByTime(6 * 60_000); });
    fireEvent.click(document.querySelector('[data-mv-schedule="in5"]'));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(onPick).toHaveBeenCalledWith(at(10, 6) + 5 * 60_000);
  });

  it('keeps its "Sends at about" times current', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(at(10, 0));
    render(<SendLater title="Send later" onPick={() => {}} onClose={() => {}} />);
    const about = () => document.querySelector('[data-mv-schedule="in1h"] .mv-schedule__about').textContent;
    const first = about();
    act(() => { vi.advanceTimersByTime(30 * 60_000 + SHEET_TICK_MS); });
    expect(about()).not.toBe(first);
  });
});

describe('the outbox while it stays open', () => {
  it('moves a row out of Scheduled once its time passed', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(at(10, 0));
    const rows = [{ id: 'out_1', state: 'queued', subject: 'Quote', scheduledMs: at(10, 0) + 5000, notBeforeMs: at(10, 0) + 5000 }];
    render(<OutboxSheet rows={rows} onClose={() => {}} />);
    expect(screen.getByText(t('mobile.outbox.scheduled'))).toBeTruthy();
    act(() => { vi.advanceTimersByTime(6000); });
    expect(screen.queryByText(t('mobile.outbox.scheduled'))).toBeNull();
    expect(document.querySelector('[data-mv-outbox-scheduled]')).toBeNull();
  });
});
