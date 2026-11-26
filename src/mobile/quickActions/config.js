// The phone's quick action configuration: desktop's own shape (src/utils/quickActions.js:
// `{ defaults: { row, selection, reader }, overrides, styleLinks }`), kept in the engine pref
// `quickActions` (settings.rs PREFS) and imported from desktop by the transfer. Row is the wheel
// a long press opens, selection the bar under a multi-select, reader unused here (the viewer's bar
// is its own pref, `quickActionsReader`, src/mobile/quickActions.js).
//
// With nothing saved the phone starts from desktop's defaults cut to what it can do (a row with
// nine actions, a bar of seven), not the 17 and 9 desktop lists: the rest stays on desktop and
// shows up in the wheel only when the person (or an import) lists it, as a disabled "on desktop"
// wedge (descriptors.js). Everything else, scopes, layouts, palettes, presets, is desktop's code.
import {
  DEFAULT_QUICK_ACTIONS, currentQuickActionScope, normalizeQuickActions, resetQuickActionScope, resolveQuickActions,
  setQuickActionScopeSurfaces, setQuickActionStyle, setQuickActionStyleLink, setQuickActionSurface, QUICK_ACTION_SURFACES,
  quickActionScopeKey,
} from '../../utils/quickActions.js';
import { QUICK_ACTION_PRESETS } from '../../utils/quickActionPresets.js';

const entries = (actions) => actions.map((action) => ({ id: action, action }));

/** The phone's row wheel before anyone changes it: the actions it can run, in desktop's order. */
export const PHONE_ROW = Object.freeze({
  ...DEFAULT_QUICK_ACTIONS.defaults.row,
  entries: entries(['toggleRead', 'star', 'unstar', 'reply', 'replyAll', 'forward', 'move', 'spam', 'deleteServer']),
  favoriteId: 'toggleRead',
});
/** The phone's selection bar before anyone changes it. */
export const PHONE_SELECTION = Object.freeze({
  ...DEFAULT_QUICK_ACTIONS.defaults.selection,
  entries: entries(['markRead', 'markUnread', 'star', 'unstar', 'move', 'spam', 'deleteServer']),
  favoriteId: 'markRead',
});
/** Desktop's defaults as the phone starts from them: what `reset to default` goes back to. */
export const PHONE_DEFAULTS = Object.freeze({
  ...DEFAULT_QUICK_ACTIONS,
  defaults: { ...DEFAULT_QUICK_ACTIONS.defaults, row: PHONE_ROW, selection: PHONE_SELECTION },
});

/** The saved configuration with the phone's defaults under any surface it does not hold. */
export function phoneQuickActions(prefs) {
  const saved = prefs && typeof prefs.quickActions === 'object' && prefs.quickActions ? prefs.quickActions : {};
  const defaults = saved.defaults && typeof saved.defaults === 'object' ? saved.defaults : {};
  return normalizeQuickActions({
    ...saved,
    defaults: { ...defaults, row: defaults.row || PHONE_ROW, selection: defaults.selection || PHONE_SELECTION },
  });
}

/**
 * The scope a list shows, as desktop keys it: All Inboxes is its unified view, a search its own
 * scope, any other folder that account's mailbox (`activeMailbox` is the folder's path).
 */
export function phoneScope({ accountId = null, folder = 'INBOX', allInboxes = false, searching = false } = {}) {
  return currentQuickActionScope({
    activeMailbox: allInboxes ? 'UNIFIED' : folder,
    activeAccountId: accountId,
    unifiedInbox: allInboxes,
    isSearchResults: searching,
  }, {});
}

/** The surface's configuration at `scope` (a view's own override, else All views'). */
export function phoneSurface(prefs, surface, scope = null) {
  return resolveQuickActions(phoneQuickActions(prefs), surface, scope).config;
}

/**
 * The four writers the shared editor calls, over the phone's prefs: each takes the saved value,
 * applies desktop's reducer and hands the whole new value to `save` (`{ quickActions }`).
 */
export function quickActionsStore(prefs, save) {
  const write = (next) => save({ quickActions: next });
  const current = () => phoneQuickActions(prefs);
  return {
    setSurface: (surface, scope, config) => write(setQuickActionSurface(current(), surface, scope, config)),
    setStyle: (surface, scope, updates) => write(setQuickActionStyle(current(), surface, scope, updates)),
    setStyleLink: (scope, linked, surface) => write(setQuickActionStyleLink(current(), scope, linked, surface)),
    resetScope: (scope, surface) => write(resetQuickActionScope(current(), scope, surface)),
  };
}

// Desktop's action sets for the phone's surfaces: MailVault is the phone's own start.
const SURFACES_OF = Object.freeze(Object.fromEntries(QUICK_ACTION_PRESETS.map((preset) => [
  preset.id,
  preset.id === 'mailvault' ? PHONE_DEFAULTS.defaults : preset.surfaces,
])));
export const PHONE_PRESETS = Object.freeze(QUICK_ACTION_PRESETS.map(({ id, labelKey }) => ({ id, labelKey, surfaces: SURFACES_OF[id] })));

// The two surfaces the phone draws, as they resolve at `scope`, written out for comparing.
const signature = (value, scope) => JSON.stringify(
  ['row', 'selection'].map((surface) => resolveQuickActions(value, surface, scope).config),
);

/** The preset the scope shows exactly (on the two surfaces the phone has), or null for a custom set. */
export function activePhonePreset(value, scope = null) {
  const saved = phoneQuickActions({ quickActions: value });
  const now = signature(saved, scope);
  return PHONE_PRESETS.find(({ surfaces }) => signature(normalizeQuickActions({ defaults: surfaces }), null) === now)?.id ?? null;
}

/** `value` with every surface of `scope` (null: All views) set to the preset, its style link off. */
export function applyPhonePreset(value, scope, presetId) {
  const saved = phoneQuickActions({ quickActions: value });
  const preset = PHONE_PRESETS.find((item) => item.id === presetId);
  if (!preset) return saved;
  const key = quickActionScopeKey(scope);
  if (key) {
    const written = setQuickActionScopeSurfaces(saved, scope, preset.surfaces);
    return normalizeQuickActions({
      ...written,
      styleLinks: { ...written.styleLinks, overrides: { ...written.styleLinks.overrides, [key]: false } },
    });
  }
  return normalizeQuickActions({ ...saved, defaults: preset.surfaces, styleLinks: { ...saved.styleLinks, global: false } });
}

export { QUICK_ACTION_SURFACES };
