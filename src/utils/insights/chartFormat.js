import { getLocale } from '../../i18n';

export const compareStable = (a, b) => a < b ? -1 : a > b ? 1 : 0;

export const chartLocale = () => getLocale() === 'en' ? 'en-GB' : getLocale();
export function senderLastDate(sender, translate) {
  const time = sender.lastAt == null ? NaN : Date.parse(sender.lastAt);
  return Number.isFinite(time)
    ? new Intl.DateTimeFormat(chartLocale(), { day: 'numeric', month: 'long', year: 'numeric' }).format(time)
    : translate('insights.chart.unknownDate');
}
export function senderAccessibleLabel(sender, translate) {
  return translate('insights.chart.senderLabel', { name: sender.name || sender.address, address: sender.address,
    count: sender.count, date: senderLastDate(sender, translate) });
}
export const filterSenders = (senders, search) => {
  const needle = search.trim().toLocaleLowerCase();
  return needle ? senders.filter(s => `${s.name || ''} ${s.address}`.toLocaleLowerCase().includes(needle)) : senders;
};
