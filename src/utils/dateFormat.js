import { format, isToday, isYesterday, isThisWeek } from 'date-fns';
import { useSettingsStore } from '../stores/settingsStore';

const DATE_PRESETS = {
  'MM/dd/yyyy': { withYear: 'MM/dd/yyyy', withoutYear: 'MM/dd' },
  'dd/MM/yyyy': { withYear: 'dd/MM/yyyy', withoutYear: 'dd/MM' },
  'yyyy-MM-dd': { withYear: 'yyyy-MM-dd', withoutYear: 'MM-dd' },
  'dd MMM yyyy': { withYear: 'dd MMM yyyy', withoutYear: 'dd MMM' },
};

export function formatEmailDate(dateStr) {
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return '';

  const { dateFormat, customDateFormat } = useSettingsStore.getState();

  if (isToday(date)) return format(date, 'h:mm a');
  if (isYesterday(date)) return 'Yesterday';
  if (isThisWeek(date)) return format(date, 'EEEE');

  const isPreviousYear = date.getFullYear() !== new Date().getFullYear();

  if (dateFormat === 'auto' || !dateFormat) {
    const options = isPreviousYear
      ? { month: 'short', day: 'numeric', year: 'numeric' }
      : { month: 'short', day: 'numeric' };
    return new Intl.DateTimeFormat(navigator.language, options).format(date);
  }

  if (dateFormat === 'custom' && customDateFormat) {
    try {
      return format(date, customDateFormat);
    } catch {
      return format(date, 'MMM d, yyyy');
    }
  }

  // Preset formats
  const preset = DATE_PRESETS[dateFormat];
  if (preset) {
    return format(date, isPreviousYear ? preset.withYear : preset.withoutYear);
  }

  // Unknown format — fallback
  return format(date, isPreviousYear ? 'MMM d, yyyy' : 'MMM d');
}
