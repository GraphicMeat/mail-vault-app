// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import MessageRow, { ROW_HEIGHT } from '../MessageRow.jsx';
import ViewerStub from '../ViewerStub.jsx';
import { formatEmailDate } from '../format.js';
import { formatEmailDate as desktopFormatEmailDate } from '../../utils/dateFormat.js';
import { t as desktopT } from '../../i18n/index.js';
import { t } from '../i18n.js';

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

  it('shows the date the desktop list would', () => {
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
    expect(onOpen).toHaveBeenCalledWith(base);
  });

  it('the list sizes rows by estimate only: no measured elements', () => {
    const src = readFileSync(resolve(process.cwd(), 'src/mobile/MessageList.jsx'), 'utf8');
    expect(src).toContain('useVirtualizer');
    expect(src).toMatch(/estimateSize:\s*\(\)\s*=>\s*ROW_HEIGHT/);
    expect(src).not.toMatch(/measureElement/);
  });
});

describe('ViewerStub', () => {
  it('shows subject and sender, and a back control at least 44px tall', () => {
    const onClose = vi.fn();
    render(<ViewerStub row={base} onClose={onClose} />);
    expect(screen.getByText('Hello')).toBeTruthy();
    expect(screen.getByText('Ada Lovelace')).toBeTruthy();
    const back = screen.getByRole('button', { name: t('common.back') });
    expect(parseInt(back.style.minHeight, 10)).toBeGreaterThanOrEqual(44);
    fireEvent.click(back);
    expect(onClose).toHaveBeenCalled();
  });
});

describe('desktop parity', () => {
  it('mobile t() matches desktop t() on the keys the mobile UI uses', () => {
    for (const k of ['common.noSubject', 'explorer.unknownSender', 'common.back', 'sidebar.inbox', 'common.retry', 'mobile.list.loadFailed', 'explorer.loading']) {
      expect(t(k)).toBe(desktopT(k));
      expect(t(k)).not.toBe(k);
    }
    expect(t('common.messageCount', { count: 3 })).toBe(desktopT('common.messageCount', { count: 3 }));
  });

  it('formatEmailDate matches desktop default settings across date ranges', () => {
    const now = new Date();
    const day = 24 * 3600 * 1000;
    const dates = [
      now.getTime() - 60 * 1000,
      now.getTime() - day,
      now.getTime() - 3 * day,
      now.getTime() - 40 * day,
      now.getTime() - 400 * day,
      Date.UTC(2019, 11, 31, 23, 59),
    ];
    for (const d of dates) {
      expect(formatEmailDate(d)).toBe(desktopFormatEmailDate(d));
    }
    expect(formatEmailDate(null)).toBe('');
    expect(formatEmailDate(NaN)).toBe('');
  });
});
