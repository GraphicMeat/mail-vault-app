import React, { useMemo, useState } from 'react';
import { AlarmClock } from 'lucide-react';
import { Popover, MenuItem } from './ui/Popover';
import { DateTimePicker } from './ui/DateTimePicker';
import { Button } from './ui/Button';
import { useSettingsStore } from '../stores/settingsStore';
import { useMailStore } from '../stores/mailStore';
import { intlLocale, hour12For } from '../utils/dateFormat';
import { isPastLocalTime, zonedTimeToEpoch } from '../utils/scheduledTime';
import { snoozePresets } from '../utils/snoozePresets';
import { snoozeEmails } from '../services/workflows/snooze';
import { useT } from '../i18n/index.js';

const WHEN = { weekday: 'short', hour: 'numeric', minute: '2-digit' };
const WIDTH = 256;

/**
 * Snooze's picker: the presets, each with the time it resolves to, and a date
 * and time of the user's own. Anchored under `anchorRect` (a quick action's
 * button, a swiped row), or near the top of the window when there is none
 * (the keyboard shortcut). Picking snoozes `keys` and closes.
 */
export function SnoozePicker({ keys, anchorRect = null, onClose }) {
  const t = useT();
  const hour12 = hour12For(useSettingsStore(s => s.timeFormat));
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const presets = useMemo(() => snoozePresets(Date.now(), tz), [tz]);
  const [custom, setCustom] = useState(null);
  const [localTime, setLocalTime] = useState('');
  const fmt = new Intl.DateTimeFormat(intlLocale(), { ...WHEN, hour12 });
  const past = !localTime || isPastLocalTime(localTime, tz);

  const pick = (wakeAt) => {
    onClose?.();
    snoozeEmails(keys, wakeAt).catch(e => useMailStore.setState({ error: t('snooze.failed', { err: e?.message || e }) }));
  };

  const style = anchorRect
    ? { top: anchorRect.bottom + 6, left: Math.max(8, Math.min(window.innerWidth - WIDTH - 8, anchorRect.left)), width: WIDTH }
    : { top: '20vh', left: `calc(50% - ${WIDTH / 2}px)`, width: WIDTH };

  return (
    <Popover open onClose={onClose} handlesTab role="menu" aria-label={t('snooze.title')} style={style} data-testid="snooze-picker">
      <div className="px-3 pt-1 pb-2 text-xs font-medium text-mail-text-muted flex items-center gap-1.5">
        <AlarmClock size={13} aria-hidden="true" />{t('snooze.title')}
      </div>
      {presets.map(preset => (
        <MenuItem key={preset.id} data-testid={`snooze-preset-${preset.id}`} onClick={() => pick(preset.at)}>
          <span className="flex-1">{t(`snooze.preset.${preset.id}`)}</span>
          <span className="text-xs text-mail-text-muted">{fmt.format(preset.at)}</span>
        </MenuItem>
      ))}
      {custom === null ? (
        <MenuItem data-testid="snooze-preset-custom" onClick={() => setCustom(true)}>{t('snooze.preset.custom')}</MenuItem>
      ) : (
        <div className="px-3 py-2 flex flex-col gap-2 border-t border-mail-border">
          <DateTimePicker value={localTime} tz={tz} onChange={setLocalTime}
            ariaLabel={t('snooze.preset.custom')} placeholder={t('snooze.pickTime')} testId="snooze-custom-time" />
          <Button variant="primary" size="sm" disabled={past} data-testid="snooze-custom-confirm"
            onClick={() => pick(zonedTimeToEpoch(localTime, tz))}>
            {t('snooze.confirm')}
          </Button>
        </div>
      )}
    </Popover>
  );
}
