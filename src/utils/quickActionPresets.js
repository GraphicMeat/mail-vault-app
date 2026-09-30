import {
  DEFAULT_QUICK_ACTIONS, normalizeQuickActions, QUICK_ACTION_SURFACES, quickActionScopeKey, resolveQuickActions,
  setQuickActionScopeSurfaces,
} from './quickActions';

// Starting sets for people coming from another mail app: what that app offers
// on a hovered message row, over several selected messages and on an open
// message, from its own documentation, mapped onto MailVault's actions. A flag
// or a pin is the star; rows and the selection bar toggle it through the Star
// and Unstar pair, the reader through its one Star.
const surface = (mode, actions, favoriteId, extra = {}) => ({
  mode,
  entries: actions.map(action => ({ id: action, action })),
  favoriteId,
  palette: 'neutral',
  radialPagination: false,
  radialLayout: 'flat',
  ...extra,
});
const selection = (selectionDisplay, selectionActionLimit, actions, favoriteId) =>
  surface('inline', actions, favoriteId, { selectionDisplay, selectionActionLimit });

export const QUICK_ACTION_PRESETS = [
  { id: 'mailvault', labelKey: 'quickActions.preset.mailvault', surfaces: DEFAULT_QUICK_ACTIONS.defaults },
  // Gmail on the web, read 2026-09-29. Hovering a row, "you can archive,
  // delete, snooze, or mark a message as read" (in that order here); the
  // toolbar over selected messages and an open one is Archive, Report spam,
  // Delete, Mark as unread and Move to, with Snooze under More
  // (https://support.google.com/mail/answer/2473038). Reply and Reply all are
  // below an open message (https://support.google.com/mail/answer/6585),
  // Forward at its bottom (https://support.google.com/mail/answer/15162918).
  {
    id: 'gmail',
    labelKey: 'quickActions.preset.gmail',
    surfaces: {
      row: surface('inline', ['archive', 'delete', 'snooze', 'toggleRead'], 'archive'),
      selection: selection('icon-only', 5, ['archive', 'spam', 'delete', 'toggleRead', 'move', 'snooze'], 'archive'),
      reader: surface('inline', ['archive', 'spam', 'delete', 'toggleRead', 'move', 'snooze', 'reply', 'replyAll', 'forward'], 'reply'),
    },
  },
  // Outlook on the web and Outlook.com, read 2026-09-29. A row's icons delete
  // it or flag it, and Reply, Reply all and Forward are at the top of a message
  // (https://support.microsoft.com/en-us/outlook/mail-in-outlook-web-app);
  // hovering a row also offers pin
  // (https://support.microsoft.com/en-us/office/flag-or-pin-a-message-in-outlook-com-8e911e69-30d6-4cc8-8c71-a1163560618a).
  // For selected messages the ribbon has Archive, Move to, Read/Unread, Pin,
  // Flag and Snooze
  // (https://support.microsoft.com/en-us/outlook/organize-your-inbox-with-archive-sweep-and-other-tools-in-outlook-on-the-web).
  // No page lists the reading pane's defaults beyond the three replies, nor
  // Delete for a selection: those come from the row's Delete and the same
  // ribbon, which acts on an open message too.
  {
    id: 'outlook',
    labelKey: 'quickActions.preset.outlook',
    surfaces: {
      row: surface('inline', ['delete', 'star', 'unstar'], 'star'),
      selection: selection('icon-label', 4, ['delete', 'archive', 'move', 'toggleRead', 'star', 'unstar', 'snooze'], 'archive'),
      reader: surface('inline', ['reply', 'replyAll', 'forward', 'delete', 'archive', 'move', 'toggleRead', 'star', 'snooze'], 'reply'),
    },
  },
  // Thunderbird, read 2026-09-29 from its own source, since its help page
  // renders only with JavaScript. An open message's header shows Reply, a
  // smart reply (Reply All where there are several recipients), Forward,
  // Archive, Junk, Delete and the star
  // (https://hg-edge.mozilla.org/comm-central/raw-file/tip/mail/base/content/msgHdrView.inc.xhtml);
  // several selected messages get Archive, Delete and the star
  // (https://hg-edge.mozilla.org/comm-central/raw-file/tip/mail/base/content/multimessageview.xhtml).
  // Its list has no hover actions, so a row offers the same three.
  {
    id: 'thunderbird',
    labelKey: 'quickActions.preset.thunderbird',
    surfaces: {
      row: surface('inline', ['archive', 'delete', 'star', 'unstar'], 'archive'),
      selection: selection('icon-label', 4, ['archive', 'delete', 'star', 'unstar'], 'archive'),
      reader: surface('inline', ['reply', 'replyAll', 'forward', 'archive', 'spam', 'delete', 'star'], 'reply'),
    },
  },
];

// Every surface of the scope (`null` for All views) set to the preset, in one
// write, with that scope's "style across sections" link off: a preset sets
// each surface's layout itself. A view stores only what the preset changes
// from All views. An unknown id changes nothing.
export function applyQuickActionPreset(value, scope, presetId) {
  const normalized = normalizeQuickActions(value);
  const preset = QUICK_ACTION_PRESETS.find(item => item.id === presetId);
  if (!preset) return normalized;
  const key = quickActionScopeKey(scope);
  if (key) {
    const written = setQuickActionScopeSurfaces(normalized, scope, preset.surfaces);
    return normalizeQuickActions({
      ...written,
      styleLinks: { ...written.styleLinks, overrides: { ...written.styleLinks.overrides, [key]: false } },
    });
  }
  return normalizeQuickActions({
    ...normalized,
    defaults: preset.surfaces,
    styleLinks: { ...normalized.styleLinks, global: false },
  });
}

// Nothing records which preset was picked: the settings keep no such field,
// and any edit after picking one makes it custom. Instead, the scope's three
// surfaces as they resolve (a view without an override of its own shows All
// views) are compared with each preset.
const signature = configFor => JSON.stringify(QUICK_ACTION_SURFACES.map(configFor));
const SIGNATURES = QUICK_ACTION_PRESETS.map(({ id, surfaces }) => {
  const { defaults } = normalizeQuickActions({ defaults: surfaces });
  return [id, signature(name => defaults[name])];
});

/** The id of the preset the scope shows exactly, or null for a custom set. */
export function activeQuickActionPreset(value, scope = null) {
  // Resolved surfaces come normalized, like each preset's signature.
  const current = signature(name => resolveQuickActions(value, name, scope).config);
  return SIGNATURES.find(([, preset]) => preset === current)?.[0] ?? null;
}
