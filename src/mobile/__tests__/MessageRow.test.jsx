// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import MessageRow, { ROW_HEIGHT } from '../MessageRow.jsx';
import { formatEmailDate, MOBILE_DATE_SETTINGS } from '../format.js';
import { formatEmailDateWith } from '../../utils/emailDateCore.js';
import { t, getMobileLocale } from '../i18n.js';
import en from '../../i18n/locales/en.json';
import { revealSide } from './fixtures/swipe.js';

afterEach(cleanup);

const base = {
  uid: 7, subject: 'Hello', fromName: 'Ada Lovelace', fromAddress: 'ada@example.test',
  dateMs: Date.UTC(2024, 2, 3, 10, 0), snippet: 'Body text', seen: false, flagged: false, hasAttachments: false,
};

const renderRow = (row, props = {}) =>
  render(<MessageRow row={row} index={3} start={0} onOpen={() => {}} {...props} />);

describe('MessageRow', () => {
  it('renders hostile shapes without throwing', () => {
    const shapes = [
      { ...base, fromName: '', fromAddress: '' },
      { ...base, subject: 'x'.repeat(500) },
      { ...base, subject: 'חשבונית לחודש נובמבר' },
      { ...base, snippet: null },
      { ...base, subject: null, fromName: null, fromAddress: null, snippet: undefined, dateMs: null },
    ];
    for (const row of shapes) {
      expect(() => renderRow(row)).not.toThrow();
      cleanup();
    }
  });

  it('falls back to the address, then to a translated unknown sender', () => {
    renderRow({ ...base, fromName: '  ' });
    expect(screen.getByText('ada@example.test')).toBeTruthy();
    cleanup();
    renderRow({ ...base, fromName: '', fromAddress: '' });
    expect(screen.getByText(t('explorer.unknownSender'))).toBeTruthy();
  });

  it('cleans text exactly as the desktop row does', () => {
    renderRow({ ...base, subject: '‮exe.txt', snippet: 'Tom &amp; Jerry​  here', fromName: 'Ev‮e' });
    expect(screen.getByText('exe.txt')).toBeTruthy();
    expect(screen.getByText('Tom & Jerry here')).toBeTruthy();
    expect(screen.getByText('Eve')).toBeTruthy();
    cleanup();
    renderRow({ ...base, subject: '   ' });
    expect(screen.getByText(t('common.noSubject'))).toBeTruthy();
  });

  it('subject, sender and snippet use dir=auto so RTL text lays out right', () => {
    const { container } = renderRow({ ...base, subject: 'חשבונית לחודש נובמבר' });
    const subj = screen.getByText('חשבונית לחודש נובמבר');
    expect(subj.getAttribute('dir')).toBe('auto');
    expect(container.querySelectorAll('[dir="auto"]').length).toBe(3);
  });

  it('shows the date from the shared formatter', () => {
    renderRow(base);
    expect(screen.getByText(formatEmailDate(base.dateMs))).toBeTruthy();
  });

  it('has a fixed height of at least 44px and a placeholder of the same height', () => {
    expect(ROW_HEIGHT).toBeGreaterThanOrEqual(44);
    const { container } = renderRow(base);
    const el = container.querySelector('[data-index="3"]');
    expect(el.style.height).toBe(`${ROW_HEIGHT}px`);
    expect(el.getAttribute('data-loaded')).toBe('1');
    cleanup();
    const { container: c2 } = renderRow(undefined);
    const ph = c2.querySelector('[data-index="3"]');
    expect(ph.style.height).toBe(`${ROW_HEIGHT}px`);
    expect(ph.getAttribute('data-loaded')).toBe('0');
  });

  it('a tap opens the row', () => {
    const onOpen = vi.fn();
    const { container } = renderRow(base, { onOpen });
    fireEvent.click(container.querySelector('[data-index="3"]'));
    expect(onOpen).toHaveBeenCalledWith(base, 3);
  });

  it('a conversation row shows its message count and reads as its messages do', () => {
    const conv = { ...base, seen: true, flagged: false, threadId: '<a@x>', threadCount: 3, threadUnread: 1, threadFlagged: true, threadUids: [7, 5, 2] };
    const onSwipe = vi.fn();
    const { container } = renderRow(conv, { onSwipe });
    const badge = container.querySelector('[data-mv-thread-count]');
    expect(badge.textContent).toBe('3');
    expect(badge.getAttribute('aria-label')).toBe(t('email.thread.messagesInThread', { count: 3 }));
    // Unread while any message is, flagged while any is.
    expect(container.querySelector('.mv-row--unread')).toBeTruthy();
    expect(container.querySelector('.mv-row__flag')).toBeTruthy();
    // The read swipe marks the conversation read (every message: App.jsx sends `threadUids`).
    fireEvent.click(revealSide(container, 'leading'));
    expect(onSwipe).toHaveBeenCalledWith('seen', expect.objectContaining({ uid: 7, threadUids: [7, 5, 2] }));
    // Its height is every row's.
    expect(container.querySelector('[data-index="3"]').style.height).toBe(`${ROW_HEIGHT}px`);
    cleanup();
    const single = renderRow(base).container;
    expect(single.querySelector('[data-mv-thread-count]')).toBeNull();
  });

  it('a flagged row shows desktop\'s filled star, 14px, under the same name', () => {
    renderRow({ ...base, flagged: true });
    const flag = screen.getByRole('img', { name: t('mobile.actions.flagged') });
    expect(flag.classList.contains('mv-row__flag')).toBe(true);
    const star = flag.querySelector('svg');
    expect(star.classList.contains('lucide-star')).toBe(true);
    expect(star.getAttribute('width')).toBe('14');
    expect(star.getAttribute('fill')).toBe('currentColor');
    cleanup();
    renderRow(base);
    expect(screen.queryByRole('img', { name: t('mobile.actions.flagged') })).toBeNull();
  });

  it('a row with attachments shows desktop\'s paperclip before the date', () => {
    const { container } = renderRow({ ...base, hasAttachments: true });
    const clip = screen.getByRole('img', { name: t('chat.topics.hasAttachments') });
    const glyph = clip.querySelector('svg');
    expect(glyph.classList.contains('lucide-paperclip')).toBe(true);
    expect(glyph.getAttribute('width')).toBe('14');
    const date = container.querySelector('.mv-row__date');
    expect(clip.nextElementSibling).toBe(date);
    // Its height is every row's.
    expect(container.querySelector('[data-index="3"]').style.height).toBe(`${ROW_HEIGHT}px`);
    cleanup();
    renderRow(base);
    expect(screen.queryByRole('img', { name: t('chat.topics.hasAttachments') })).toBeNull();
  });

  it('styles: both glyphs are fixed boxes that cannot change the row\'s height', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/mobile/mobile.css'), 'utf8');
    const rule = (sel) => css.match(new RegExp(`(?:^|\\n)${sel.replace(/[.]/g, '\\.')} \\{([^}]*)\\}`))?.[1] ?? '';
    const both = rule('.mv-row__flag, .mv-row__attach');
    expect(both).toContain('flex: none');
    expect(both).toContain('width: 14px');
    expect(both).toContain('height: 14px');
    expect(rule('.mv-row__flag')).toContain('color: var(--mv-flag)');
    expect(rule('.mv-row__attach')).toContain('color: var(--mail-text-muted)');
  });

  it('the list sizes rows by estimate only: no measured elements', () => {
    const src = readFileSync(resolve(process.cwd(), 'src/mobile/MessageList.jsx'), 'utf8');
    expect(src).toContain('useVirtualizer');
    expect(src).toMatch(/estimateSize:\s*\(\)\s*=>\s*height/);
    expect(src).not.toMatch(/measureElement/);
  });
});

describe('mobile wrappers supply mobile defaults to the shared cores', () => {
  it('t() is the shared lookup over the English catalog', () => {
    expect(getMobileLocale()).toBe('en');
    for (const k of ['common.noSubject', 'explorer.unknownSender', 'common.back', 'sidebar.inbox', 'common.retry', 'mobile.list.loadFailed', 'explorer.loading']) {
      expect(t(k)).toBe(en[k]);
    }
    expect(t('common.messageCount', { count: 1 })).toBe('1 message');
    expect(t('common.messageCount', { count: 3 })).toBe('3 messages');
  });

  it('formatEmailDate passes auto settings, English and now to the core', () => {
    expect(MOBILE_DATE_SETTINGS).toEqual({ dateFormat: 'auto', customDateFormat: '', timeFormat: 'auto' });
    const now = new Date(2026, 10, 4, 15, 0); // Wednesday
    const day = 24 * 3600 * 1000;
    for (const d of [now.getTime() - 60000, now.getTime() - day, now.getTime() - 2 * day, new Date(2025, 0, 2).getTime()]) {
      expect(formatEmailDate(d, now)).toBe(
        formatEmailDateWith(d, { dateFormat: 'auto', customDateFormat: '', timeFormat: 'auto', appLocale: 'en', translate: t, now }),
      );
    }
    expect(formatEmailDate(now.getTime() - day, now)).toBe('Yesterday');
    expect(formatEmailDate(null, now)).toBe('');
    expect(formatEmailDate(NaN, now)).toBe('');
  });
});
