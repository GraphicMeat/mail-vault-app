// @vitest-environment jsdom
import { it, expect, vi } from 'vitest';
const settings = vi.hoisted(() => ({ dateFormat: 'yyyy-MM-dd', timeFormat: '24h', customDateFormat: '' }));
vi.mock('../../stores/settingsStore', () => ({ useSettingsStore: { getState: () => settings } }));
import { formatDateTime } from '../dateFormat';
import { buildQuoteBlocks } from '../replyQuote';
it('keeps actual localized date formatting in frontend quote presentation', () => {
  const m = { date: '2026-10-24T12:34:00Z', from: { name: '<&>', address: 'a@example.test' }, subject: '<&>', text: 'text' };
  expect(formatDateTime(m.date)).toBe('2026-10-24, 12:34');
  expect(buildQuoteBlocks(m, 'Original').quotedHeaderHtml).toContain('Date: 2026-10-24, 12:34');
  settings.dateFormat = 'custom'; settings.customDateFormat = "'Date <&>' yyyy";
  expect(buildQuoteBlocks(m, 'Original').quotedHeaderHtml).toContain('Date: Date &lt;&amp;&gt; 2026, 12:34');
  expect(buildQuoteBlocks({ ...m, date: null }, 'Original').quotedHeaderHtml).toContain('Date: <br>');
});
