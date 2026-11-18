// Settings > Appearance > Quick actions on the phone: desktop's quick action views
// (src/components/settings/views/QuickActionsView.jsx) for the phone's one surface, the bar under
// an open message (`quickActionsReader`, quickActions.js): an action set to start from (desktop's
// presets, mapped onto the phone's actions), then which actions sit on the bar and in what order,
// at most four (desktop's surface tabs, with the reader's only), each removable and moved by its
// handle; every other action stays under the bar's
// More and can be added while the bar has room. Each change writes the whole list
// (`mobile.prefs.set` through the store's setPrefs); the viewer reads it as it renders. Desktop's
// scope, other surfaces, layouts, palettes and the samples drawn with its list rows are not the
// phone's. Under the bar, desktop's list of local labels (tags), each deleted with its button
// (`mobile.tags.delete` through tags.js); labels are made and applied from a message's More.
import React, { useEffect, useState } from 'react';
import { TagListView } from '../../components/tags/TagViews';
import { ensureTags, useTagStore } from '../tags.js';
import {
  QuickActionAddView, QuickActionEntryListView, QuickActionPresetsView, QuickActionsView,
} from '../../components/settings/views/QuickActionsView';
import { SettingsTabs } from '../../components/ui/SettingsTabs';
import { useMobileStore } from '../store.js';
import { useT } from '../i18n.js';
import { BAR_LIMIT, READER_ACTIONS, READER_PRESETS, activeReaderPreset, readerBar } from '../quickActions.js';
import { SaveFailed, useSavePrefs } from './MobileViewEnv.jsx';

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

/** Rendered inside Appearance's MobileViewEnv. */
export default function QuickActions() {
  const t = useT();
  const list = useMobileStore((s) => s.prefs.quickActionsReader);
  const [savePrefs, failed] = useSavePrefs();
  const bar = readerBar(list);
  const rest = READER_ACTIONS.filter((a) => !bar.includes(a));
  const [addType, setAddType] = useState(rest[0] || '');
  useEffect(() => { if (!rest.includes(addType)) setAddType(rest[0] || ''); }, [rest.join(), addType]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = (next) => savePrefs({ quickActionsReader: next });
  const labels = useTagStore((s) => s.tags);
  useEffect(() => { ensureTags(); }, []);

  return (
    <>
      <QuickActionsView description={t('mobile.settings.quickActionsHint')}>
        <QuickActionPresetsView presets={READER_PRESETS} active={activeReaderPreset(bar)}
          onApply={(id) => { const hit = READER_PRESETS.find((p) => p.id === id); if (hit) save([...hit.bar]); }} />
        <SettingsTabs tabs={[{ id: 'reader', label: t('quickActions.surface.reader') }]} value="reader" onChange={() => {}} label={t('quickActions.surface')}>
        <QuickActionEntryListView
          entries={bar.map((action) => ({ id: action, action, label: t(LABELS[action]) }))}
          onReorder={(ids) => save(readerBar(ids))}
          onRemove={(index) => save(bar.filter((_, i) => i !== index))} />
        <QuickActionAddView
          actions={rest.map((action) => ({ value: action, labelKey: LABELS[action] }))}
          addType={addType} onAddType={setAddType}
          onAdd={() => { if (rest.includes(addType)) save([...bar, addType]); }}
          blocked={bar.length >= BAR_LIMIT || !rest.includes(addType)} />
        <TagListView tags={labels} onDelete={(id) => useTagStore.getState().deleteTag(id)} />
        </SettingsTabs>
      </QuickActionsView>
      <SaveFailed failed={failed} />
    </>
  );
}
