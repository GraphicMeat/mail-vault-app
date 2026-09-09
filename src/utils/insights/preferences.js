const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T12:00:00Z`))
  && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;

export function normalizeInsightsPreferences(value = {}, availableAccountIds) {
  const candidate = value && typeof value === 'object' ? value : {};
  let accountIds = Array.isArray(candidate.accountIds)
    ? [...new Set(candidate.accountIds.filter(id => typeof id === 'string' && (!availableAccountIds || availableAccountIds.includes(id))))] : null;
  if (!accountIds?.length) accountIds = null;
  const custom = candidate.range === 'custom' && validDate(candidate.startDate) && validDate(candidate.endDate) && candidate.startDate <= candidate.endDate;
  return {
    tab: ['timeline', 'activity'].includes(candidate.tab) ? candidate.tab : 'map',
    accountIds,
    range: custom ? 'custom' : ['30d', '90d'].includes(candidate.range) ? candidate.range : '12m',
    startDate: custom ? candidate.startDate : null,
    endDate: custom ? candidate.endDate : null,
    direction: ['sent', 'both'].includes(candidate.direction) ? candidate.direction : 'received',
    hideAutomated: candidate.hideAutomated === true,
  };
}

export function insightsDateRange(preferences, now = new Date(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  const prefs = normalizeInsightsPreferences(preferences);
  if (prefs.range === 'custom') return { startDate: prefs.startDate, endDate: prefs.endDate };
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now).map(p => [p.type, p.value]));
  const endDate = `${parts.year}-${parts.month}-${parts.day}`;
  const date = new Date(`${endDate}T12:00:00Z`);
  if (prefs.range === '12m') {
    const year = date.getUTCFullYear() - 1, month = date.getUTCMonth();
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    date.setUTCFullYear(year, month, Math.min(date.getUTCDate(), lastDay));
    date.setUTCDate(date.getUTCDate() + 1);
  } else date.setUTCDate(date.getUTCDate() - (prefs.range === '90d' ? 89 : 29));
  return { startDate: date.toISOString().slice(0, 10), endDate };
}
