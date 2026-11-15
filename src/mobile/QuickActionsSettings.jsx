// Settings > Appearance > Quick actions: the phone's share of the desktop's Quick actions. The
// desktop's reader surface is the viewer's bar (`quickActionsReader`, quickActions.js): an action
// set to start from (the desktop's presets, mapped onto the phone's actions), then which actions
// sit on the bar and in what order, at most four. Every other action stays under the bar's More.
// Each change writes the whole list (`mobile.prefs.set` through the store's setPrefs); the viewer
// reads it as it renders.
import React, { useState } from 'react';
import { useMobileStore } from './store.js';
import { useT } from './i18n.js';
import { Choice } from './SettingsPrefs.jsx';
import { BAR_LIMIT, READER_ACTIONS, READER_PRESETS, activeReaderPreset, readerBar } from './quickActions.js';

const LABELS = {
  toggleRead: 'quickActions.action.toggleRead',
  flag: 'mobile.actions.flag',
  move: 'mobile.actions.move',
  delete: 'common.delete',
  spam: 'quickActions.action.spam',
  reply: 'emailActionBar.reply',
  replyAll: 'emailActionBar.replyAll',
  forward: 'emailActionBar.forward',
};

export default function QuickActionsSettings() {
  const t = useT();
  const prefs = useMobileStore((s) => s.prefs);
  const [failed, setFailed] = useState(false);
  const bar = readerBar(prefs.quickActionsReader);
  const rest = READER_ACTIONS.filter((a) => !bar.includes(a));
  const preset = activeReaderPreset(bar);
  const save = async (next) => {
    const ok = await useMobileStore.getState().setPrefs({ quickActionsReader: next });
    setFailed(!ok);
  };
  const swap = (i, j) => {
    const next = [...bar];
    [next[i], next[j]] = [next[j], next[i]];
    save(next);
  };
  const presetOptions = READER_PRESETS.map((p) => [p.id, t(p.labelKey)]);
  if (!preset) presetOptions.push(['custom', t('quickActions.preset.custom')]);

  return (
    <>
      <div className="mv-settings__list">
        <Choice
          name="quickActionsPreset"
          label={t('quickActions.presets')}
          value={preset || 'custom'}
          options={presetOptions}
          onChange={(id) => {
            const hit = READER_PRESETS.find((p) => p.id === id);
            if (hit) save([...hit.bar]);
          }}
        />
      </div>
      <p className="mv-settings__note">{t('mobile.settings.quickActionsHint')}</p>

      <h2 className="mv-settings__heading">{t('quickActions.surface.reader')}</h2>
      <div className="mv-settings__list" data-mv-qa-bar>
        {bar.map((action, i) => (
          <div key={action} className="mv-setrow" data-mv-qa-action={action}>
            <span className="mv-setting__text">
              <span className="mv-setting__label">{t(LABELS[action])}</span>
            </span>
            <button type="button" className="mv-textbtn" data-mv-qa-up disabled={i === 0} aria-label={`${t('views.moveUp')}: ${t(LABELS[action])}`} onClick={() => swap(i, i - 1)}>↑</button>
            <button type="button" className="mv-textbtn" data-mv-qa-down disabled={i === bar.length - 1} aria-label={`${t('views.moveDown')}: ${t(LABELS[action])}`} onClick={() => swap(i, i + 1)}>↓</button>
            <button type="button" className="mv-textbtn mv-textbtn--danger" data-mv-qa-remove aria-label={`${t('quickActions.removeAction')}: ${t(LABELS[action])}`} onClick={() => save(bar.filter((a) => a !== action))}>
              {t('common.remove')}
            </button>
          </div>
        ))}
      </div>

      <h2 className="mv-settings__heading">{t('mobile.viewer.more')}</h2>
      <div className="mv-settings__list" data-mv-qa-more>
        {rest.map((action) => (
          <div key={action} className="mv-setrow" data-mv-qa-action={action}>
            <span className="mv-setting__text">
              <span className="mv-setting__label">{t(LABELS[action])}</span>
            </span>
            <button type="button" className="mv-textbtn" data-mv-qa-add disabled={bar.length >= BAR_LIMIT} aria-label={`${t('quickActions.addAction')}: ${t(LABELS[action])}`} onClick={() => save([...bar, action])}>
              {t('quickActions.addAction')}
            </button>
          </div>
        ))}
      </div>
      {failed && <p className="mv-settings__note mv-settings__note--error" role="alert">{t('mobile.settings.saveFailed')}</p>}
    </>
  );
}
