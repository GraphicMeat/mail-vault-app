import { daemonCall } from './daemonClient';
import { useSettingsStore } from '../stores/settingsStore';
import { useTagStore } from '../stores/tagStore';
import { useViewStore } from '../stores/viewStore';

/// Hand the settings-file labels (`localMailLabels`) to the daemon once.
///
/// The app reads its own settings file and sends the rows over; the daemon
/// never opens `frontend-settings.json`. It re-keys each assignment onto the
/// message's identity and answers with the tag every legacy label became, so
/// a configured `tag` quick action can be repointed in the same pass.
///
/// Returns false, leaving every legacy key in place, when the daemon cannot
/// resolve the assignments yet (a search index that has not reached the
/// account). The next launch tries again.
export async function bootstrapTags() {
  try {
    await useTagStore.getState().loadTags();
  } catch (error) {
    console.warn('[tags] could not load tags:', error?.message || error);
  }
  try {
    // The starters are seeded by the daemon on this first list.
    await useViewStore.getState().loadViews();
    await useViewStore.getState().refreshCounts();
  } catch (error) {
    console.warn('[views] could not load the saved views:', error?.message || error);
  }
  return migrateLocalMailLabels();
}

export async function migrateLocalMailLabels() {
  const state = useSettingsStore.getState();
  const labels = state.localMailLabels || [];
  const assignments = state.localMailLabelAssignments || {};
  if (!labels.length && !Object.keys(assignments).length) return true;

  const flat = [];
  for (const [key, labelIds] of Object.entries(assignments)) {
    let parsed;
    try {
      parsed = JSON.parse(key);
    } catch {
      continue;
    }
    const [accountId, mailbox, uid] = Array.isArray(parsed) ? parsed : [];
    if (!accountId || !mailbox || uid == null) continue;
    for (const labelId of labelIds || []) {
      flat.push({ labelId, accountId, mailbox, uid: Number(uid) });
    }
  }

  let reply;
  try {
    reply = await daemonCall('tags.migrate_legacy', { labels, assignments: flat });
  } catch (error) {
    console.warn('[tags] legacy labels not migrated yet:', error?.message || error);
    return false;
  }

  const tagOfLabel = reply?.tagOfLabel || {};
  useSettingsStore.setState(current => ({
    localMailLabels: [],
    localMailLabelAssignments: {},
    quickActions: repointQuickActions(current.quickActions, tagOfLabel),
  }));
  await useTagStore.getState().loadTags();
  return true;
}

/// A `tag` quick action stores the id of the label it applies. Left alone, a
/// configured one would point at a label that no longer exists and render as
/// the generic "Tag" entry. Both the default surfaces and every per-scope
/// override carry entries.
function repointQuickActions(quickActions, tagOfLabel) {
  if (!quickActions || typeof quickActions !== 'object') return quickActions;
  const mapEntry = entry => {
    if (!entry || entry.action !== 'tag') return entry;
    const tagId = entry.params?.tagId || tagOfLabel[entry.params?.labelId];
    if (!tagId) return entry;
    return { ...entry, id: `tag:${tagId}`, params: { tagId } };
  };
  const mapSurface = surface =>
    (Array.isArray(surface?.entries) ? { ...surface, entries: surface.entries.map(mapEntry) } : surface);
  const mapSurfaces = group =>
    Object.fromEntries(Object.entries(group || {}).map(([name, surface]) => [name, mapSurface(surface)]));
  return {
    ...quickActions,
    defaults: mapSurfaces(quickActions.defaults),
    overrides: Object.fromEntries(
      Object.entries(quickActions.overrides || {}).map(([key, scoped]) => [key, mapSurfaces(scoped)])
    ),
  };
}
