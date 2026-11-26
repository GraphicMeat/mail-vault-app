// Settings > Appearance > Quick actions on the phone: desktop's own editor
// (src/components/settings/views/QuickActionsEditorView.jsx) over the phone's `quickActions` pref
// (the desktop's shape, quickActions/config.js): the action sets of other mail apps, then a tab
// each for the list row (the wheel a long press opens) and the selection bar, with desktop's
// actions, layout, palette and scope controls, then a third, the viewer's bar (`quickActionsReader`,
// quickActions.js): which actions sit on the bar under an open message and in what order, at most
// four, the rest under its More. Every change writes the whole value (`mobile.prefs.set` through
// the store's setPrefs); the list, the bar and the viewer read it as they render. The live samples
// desktop draws with its own list row are not the phone's. Under the viewer's bar, desktop's list
// of local labels (tags), each deleted with its button (`mobile.tags.delete` through tags.js);
// labels are made and applied from a message's More or the wheel's Tag.
import React, { useEffect, useMemo, useState } from 'react';
import { TagListView } from '../../components/tags/TagViews';
import { ensureTags, useTagStore } from '../tags.js';
import {
  QuickActionAddView, QuickActionEntryListView, QuickActionPresetsView, QuickActionsView,
} from '../../components/settings/views/QuickActionsView';
import { QuickActionsEditorView } from '../../components/settings/views/QuickActionsEditorView';
import { useMobileStore } from '../store.js';
import { useT } from '../i18n.js';
import { ALL_INBOXES } from '../folders.js';
import { BAR_LIMIT, READER_ACTIONS, READER_PRESETS, readerBar } from '../quickActions.js';
import {
  PHONE_DEFAULTS, PHONE_PRESETS, activePhonePreset, applyPhonePreset, phoneQuickActions, phoneScope, quickActionsStore,
} from '../quickActions/config.js';
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
const EMPTY = Object.freeze([]);

/** The viewer's bar: desktop's entry list and add controls over `quickActionsReader`. */
function ReaderBar({ save }) {
  const t = useT();
  const list = useMobileStore((s) => s.prefs.quickActionsReader);
  const bar = readerBar(list);
  const rest = READER_ACTIONS.filter((a) => !bar.includes(a));
  const [addType, setAddType] = useState(rest[0] || '');
  useEffect(() => { if (!rest.includes(addType)) setAddType(rest[0] || ''); }, [rest.join(), addType]); // eslint-disable-line react-hooks/exhaustive-deps
  const labels = useTagStore((s) => s.tags);
  useEffect(() => { ensureTags(); }, []);
  return (
    <>
      <QuickActionEntryListView
        entries={bar.map((action) => ({ id: action, action, label: t(LABELS[action]) }))}
        onReorder={(ids) => save({ quickActionsReader: readerBar(ids) })}
        onRemove={(index) => save({ quickActionsReader: bar.filter((_, i) => i !== index) })} />
      <QuickActionAddView
        actions={rest.map((action) => ({ value: action, labelKey: LABELS[action] }))}
        addType={addType} onAddType={setAddType}
        onAdd={() => { if (rest.includes(addType)) save({ quickActionsReader: [...bar, addType] }); }}
        blocked={bar.length >= BAR_LIMIT || !rest.includes(addType)} />
      <TagListView tags={labels} onDelete={(id) => useTagStore.getState().deleteTag(id)} />
    </>
  );
}

/** Rendered inside Appearance's MobileViewEnv. */
export default function QuickActions() {
  const t = useT();
  const prefs = useMobileStore((s) => s.prefs);
  const accountId = useMobileStore((s) => s.activeAccountId);
  const folder = useMobileStore((s) => s.activeFolder);
  const accounts = useMobileStore((s) => s.accounts);
  const folders = useMobileStore((s) => s.folders);
  const [savePrefs, failed] = useSavePrefs();
  const labels = useTagStore((s) => s.tags);
  useEffect(() => { ensureTags(); }, []);
  const quickActions = useMemo(() => phoneQuickActions(prefs), [prefs]);
  const allInboxes = folder === ALL_INBOXES;
  const scope = phoneScope({ accountId, folder, allInboxes });
  const store = useMemo(() => quickActionsStore(prefs, savePrefs), [prefs]); // eslint-disable-line react-hooks/exhaustive-deps
  const readerPresetFor = (id) => READER_PRESETS.find((p) => p.id === id);

  return (
    <>
      <QuickActionsView description={t('mobile.settings.quickActionsHint')}>
        <QuickActionsEditorView
          quickActions={quickActions}
          defaults={PHONE_DEFAULTS}
          scope={scope}
          scopeAccount={allInboxes ? '' : (accounts || []).find((a) => a.id === accountId)?.email || ''}
          surfaces={['row', 'selection']}
          extraTabs={[{
            id: 'reader',
            label: t('quickActions.surface.reader'),
            content: <ReaderBar save={savePrefs} />,
          }]}
          labels={labels}
          templates={EMPTY}
          folders={(folders || EMPTY).filter((f) => !f.noselect && f.path && f.path !== folder)}
          activeAccountId={accountId || ''}
          createLabel={async (name) => {
            const id = await useTagStore.getState().createTag(name);
            return id ? { id, name } : null;
          }}
          store={store}
          renderPresets={(target) => (
            <QuickActionPresetsView
              presets={PHONE_PRESETS}
              active={activePhonePreset(quickActions, target)}
              onApply={(id) => {
                const patch = { quickActions: applyPhonePreset(quickActions, target, id) };
                // The viewer's bar follows the set, as a desktop import maps it (quickActions.js).
                if (!target) patch.quickActionsReader = [...readerPresetFor(id).bar];
                savePrefs(patch);
              }} />
          )}
        />
      </QuickActionsView>
      <SaveFailed failed={failed} />
    </>
  );
}
