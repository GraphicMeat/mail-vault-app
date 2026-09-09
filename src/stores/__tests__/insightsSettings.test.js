import { describe, expect, it } from 'vitest';
import { normalizeInsightsPreferences, insightsDateRange } from '../../utils/insights/preferences';

describe('Insights preferences', () => {
  it('defaults old profiles without retaining transient or mail fields', () => {
    expect(normalizeInsightsPreferences({ tab: 'bad', headers: [{secret: true}], direction: 'bogus', isOpen: true })).toEqual({
      tab: 'map', accountIds: null, range: '12m', startDate: null, endDate: null,
      direction: 'received', hideAutomated: false,
    });
  });
  it('keeps valid custom dates and prunes deleted accounts', () => {
    expect(normalizeInsightsPreferences({ tab:'timeline', accountIds:['gone','a','a'], range:'custom', startDate:'2024-02-29', endDate:'2024-03-02', direction:'both', hideAutomated:true }, ['a'])).toEqual({
      tab:'timeline', accountIds:['a'], range:'custom', startDate:'2024-02-29', endDate:'2024-03-02', direction:'both', hideAutomated:true,
    });
  });
  it('rejects reversed and impossible dates without coercing them into a real day', () => {
    expect(normalizeInsightsPreferences({range:'custom',startDate:'2026-02-30',endDate:'2026-03-01'}).range).toBe('12m');
    expect(normalizeInsightsPreferences({range:'custom',startDate:'2026-09-10',endDate:'2026-09-09'}).range).toBe('12m');
  });
  it('uses inclusive local calendar dates across DST and leap years', () => {
    const now = new Date('2026-03-30T12:00:00Z');
    expect(insightsDateRange({range:'30d'}, now, 'Europe/Vilnius')).toEqual({startDate:'2026-03-01',endDate:'2026-03-30'});
    expect(insightsDateRange({range:'12m'}, new Date('2024-02-29T12:00:00Z'), 'Europe/Vilnius')).toEqual({startDate:'2023-03-01',endDate:'2024-02-29'});
  });
});
