export const QUICK_ACTION_SURFACES = ['row', 'selection', 'reader'];
export const QUICK_ACTION_MODES = ['inline', 'menu', 'radial', 'favorite-menu'];
export const QUICK_ACTION_PALETTES = ['neutral', 'semantic', 'custom'];
export const QUICK_ACTION_TYPES = [
  'archive', 'unarchive', 'delete', 'deleteServer', 'deleteEverywhere',
  'toggleRead', 'markRead', 'markUnread', 'star', 'unstar', 'tag', 'move',
  'spam', 'reply', 'replyAll', 'forward', 'replyTemplate', 'export', 'newMessage',
  'open', 'source', 'theme', 'snooze',
  // Last in the row defaults (settingsStore's v10 migration appends it to a
  // saved row list); never a reader default, since the reader's grouped
  // layout keys off its exact list. Hidden on rows without List-Unsubscribe.
  'unsubscribe',
];

// The actions each surface can offer: a row has no reader tools, the reader
// no New message, and the selection bar only what acts on many at once.
export const QUICK_ACTION_SURFACE_ACTIONS = {
  row: QUICK_ACTION_TYPES.filter(action => !['open', 'source', 'theme'].includes(action)),
  selection: [
    'archive', 'unarchive', 'delete', 'deleteServer', 'deleteEverywhere', 'toggleRead', 'markRead',
    'markUnread', 'star', 'unstar', 'tag', 'move', 'spam', 'export', 'snooze',
  ],
  reader: QUICK_ACTION_TYPES.filter(action => action !== 'newMessage'),
};

export const RADIAL_LAYOUTS = ['flat', 'categories'];
// The wheel's categories, in wheel order. Every action type sits in exactly
// one; a radial surface with `radialLayout: 'categories'` shows one wedge per
// category and fans its actions out beside it.
export const RADIAL_CATEGORIES = {
  send: ['reply', 'replyAll', 'forward', 'replyTemplate', 'newMessage'],
  mark: ['toggleRead', 'markRead', 'markUnread', 'star', 'unstar'],
  organize: ['archive', 'unarchive', 'move', 'tag', 'snooze'],
  delete: ['delete', 'deleteServer', 'deleteEverywhere', 'spam', 'unsubscribe'],
  more: ['open', 'source', 'theme', 'export'],
};
const CATEGORY_OF = new Map(Object.entries(RADIAL_CATEGORIES)
  .flatMap(([category, actions]) => actions.map(action => [action, category])));
const CATEGORY_IDS = Object.keys(RADIAL_CATEGORIES);
// The one canonical order of every action: category by category, as the wheel
// lists them. A newly added action joins its category here (see
// insertQuickActionEntry), and Settings shows it as the reference list.
export const QUICK_ACTION_ORDER = Object.values(RADIAL_CATEGORIES).flat();
export const quickActionCategory = action => CATEGORY_OF.get(action) || 'more';

// The inner ring of a categorized wheel: one wedge per category in
// RADIAL_CATEGORIES order, each holding its entries in their configured order.
// The favorite is not pulled out of its category: it belongs to the
// favorite-plus-menu layout, never to the wheel. `visibility[action] === false`
// drops an entry (actionVisibility's shape); a category left empty is gone and
// one left with a single entry becomes that entry's direct wedge.
export function groupRadialEntries(entries, visibility = {}) {
  const shown = (entries || []).filter(item => visibility?.[item.action] !== false);
  const groups = [];
  for (const id of CATEGORY_IDS) {
    const members = shown.filter(item => quickActionCategory(item.action) === id);
    if (members.length === 1) groups.push({ type: 'action', entry: members[0] });
    else if (members.length) groups.push({ type: 'category', id, entries: members });
  }
  return groups;
}

// Adds `item` at its designated place rather than at the bottom: among the
// entries of its own category, before the first one that comes after it in
// QUICK_ACTION_ORDER (after the last of them otherwise). With none of its
// category configured, it goes before the first entry of a later category.
// The person's own order of everything else is kept.
export function insertQuickActionEntry(entries, item) {
  const list = [...(entries || [])];
  const rank = action => QUICK_ACTION_ORDER.indexOf(action);
  const category = CATEGORY_IDS.indexOf(quickActionCategory(item.action));
  const categoryOf = entry => CATEGORY_IDS.indexOf(quickActionCategory(entry.action));
  const same = list.map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => categoryOf(entry) === category);
  let at;
  if (same.length) {
    const next = same.find(({ entry }) => rank(entry.action) > rank(item.action));
    at = next ? next.index : same.at(-1).index + 1;
  } else {
    at = list.findIndex(entry => categoryOf(entry) > category);
    if (at < 0) at = list.length;
  }
  list.splice(at, 0, item);
  return list;
}

const entry = (action, extra = {}) => ({ id: action, action, ...extra });
export const DEFAULT_QUICK_ACTIONS = {
  defaults: {
    row: {
      mode: 'radial',
      entries: [
        entry('archive'), entry('unarchive'), entry('toggleRead'), entry('star'), entry('unstar'),
        entry('reply'), entry('replyAll'), entry('forward'), entry('newMessage'), entry('move'),
        entry('spam'), entry('deleteServer'), entry('deleteEverywhere'), entry('export'), entry('snooze'),
        entry('unsubscribe'),
      ],
      favoriteId: 'archive', palette: 'semantic', radialPagination: false, radialLayout: 'flat',
    },
    selection: {
      mode: 'inline',
      entries: ['markRead', 'markUnread', 'archive', 'unarchive', 'move', 'deleteServer', 'deleteEverywhere', 'export', 'snooze']
        .map(action => entry(action)),
      favoriteId: 'archive', palette: 'semantic', radialPagination: false, radialLayout: 'flat',
      selectionDisplay: 'icon-label', selectionActionLimit: 3,
    },
    reader: {
      mode: 'inline',
      entries: ['reply', 'replyAll', 'forward', 'archive', 'delete', 'move', 'toggleRead', 'star', 'export', 'open', 'source', 'theme']
        .map(action => entry(action)),
      favoriteId: 'reply', palette: 'semantic', radialPagination: false, radialLayout: 'flat',
    },
  },
  overrides: {},
  // Existing configurations stay independent until a person explicitly links
  // the present scope. Scoped keys may opt in without changing the global
  // choice or any other view.
  styleLinks: { global: false, overrides: {} },
};

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const nonEmptyString = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 512;
const normalizeColor = value => {
  if (typeof value !== 'string') return undefined;
  const color = value.trim();
  if (/^#[\da-f]{3}$/i.test(color)) return `#${[...color.slice(1)].map(ch => ch + ch).join('').toLowerCase()}`;
  return /^#[\da-f]{6}$/i.test(color) ? color.toLowerCase() : undefined;
};

function normalizeEntry(value) {
  if (!object(value) || !QUICK_ACTION_TYPES.includes(value.action)) return null;
  const params = object(value.params) ? value.params : {};
  // Tags moved from the settings file into the daemon's store, so an entry
  // configured before that move still names `labelId`. The migration repoints
  // it; this keeps it working in the meantime rather than rendering as the
  // generic "Tag" entry.
  const tagId = nonEmptyString(params.tagId) ? params.tagId : nonEmptyString(params.labelId) ? params.labelId : null;
  if (value.action === 'tag' && !tagId) return null;
  if (value.action === 'move' && params.mailbox != null && !nonEmptyString(params.mailbox)) return null;
  if (value.action === 'replyTemplate' && !nonEmptyString(params.templateId)) return null;
  const id = nonEmptyString(value.id)
    ? value.id.trim()
    : value.action === 'tag' ? `tag:${tagId.trim()}`
      : value.action === 'move' ? `move:${params.mailbox}`
        : value.action === 'replyTemplate' ? `replyTemplate:${params.templateId}` : value.action;
  const color = normalizeColor(value.color);
  return {
    id,
    action: value.action,
    ...(value.action === 'tag' ? { params: { tagId: tagId.trim() } } : {}),
    ...(value.action === 'move' ? { params: { ...(nonEmptyString(params.mailbox) ? { mailbox: params.mailbox.trim() } : {}), ...(nonEmptyString(params.accountId) ? { accountId: params.accountId.trim() } : {}) } } : {}),
    ...(value.action === 'replyTemplate' ? { params: { templateId: params.templateId.trim() } } : {}),
    ...(color ? { color } : {}),
  };
}

function normalizeEntries(list) {
  const unique = [];
  const seen = new Set();
  for (const item of list.map(normalizeEntry).filter(Boolean)) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    unique.push(item);
  }
  return unique;
}
const SELECTION_DISPLAYS = ['icon-label', 'icon-only'];
const clampSelectionLimit = value => Math.max(1, Math.min(6, value));

// A missing surface or list takes the fallback's, normalized like a saved one
// so that normalizing twice changes nothing.
function normalizeSurface(input, fallback) {
  const value = object(input) ? input : {};
  const unique = normalizeEntries(Array.isArray(value.entries) ? value.entries : fallback.entries || []);
  const requestedFavorite = nonEmptyString(value.favoriteId) ? value.favoriteId.trim() : fallback.favoriteId;
  const safeFallback = unique.find(item => !['delete', 'deleteServer', 'deleteEverywhere', 'unarchive'].includes(item.action))?.id;
  const favoriteId = unique.some(item => item.id === requestedFavorite)
    ? requestedFavorite
    : safeFallback || null;
  return {
    mode: QUICK_ACTION_MODES.includes(value.mode) ? value.mode : fallback.mode,
    entries: unique,
    favoriteId,
    // Keep an explicitly selected neutral/custom palette. Older settings that
    // omit a palette inherit the surface default, which is now colored.
    palette: QUICK_ACTION_PALETTES.includes(value.palette) ? value.palette : fallback.palette,
    radialPagination: typeof value.radialPagination === 'boolean' ? value.radialPagination : !!fallback.radialPagination,
    radialLayout: RADIAL_LAYOUTS.includes(value.radialLayout) ? value.radialLayout : fallback.radialLayout || 'flat',
    ...(fallback.selectionDisplay ? {
      selectionDisplay: SELECTION_DISPLAYS.includes(value.selectionDisplay) ? value.selectionDisplay : fallback.selectionDisplay,
      selectionActionLimit: Number.isInteger(value.selectionActionLimit)
        ? clampSelectionLimit(value.selectionActionLimit) : fallback.selectionActionLimit,
    } : {}),
  };
}

// The fields a view may set for itself. A view's override holds only those it
// sets; the rest resolve from All views, so an All-views edit reaches every
// view that does not set that field. `entries` is one field: a view's own list
// replaces the All-views list whole, never entry by entry.
const OVERRIDE_FIELDS = [
  'mode', 'entries', 'favoriteId', 'palette', 'radialPagination', 'radialLayout', 'selectionDisplay', 'selectionActionLimit',
];

// A view's own fields, each checked as normalizeSurface checks it. An invalid
// one is dropped, so the view inherits it, rather than replaced by the
// default: a default written here would pin it against later All-views edits.
// Nothing is compared with All views, so a field the view set stays set even
// when All views later comes to hold the same value.
function normalizeOverrideSurface(value, surface) {
  if (!object(value)) return null;
  const selection = !!DEFAULT_QUICK_ACTIONS.defaults[surface].selectionDisplay;
  const own = {
    ...(QUICK_ACTION_MODES.includes(value.mode) ? { mode: value.mode } : {}),
    ...(Array.isArray(value.entries) ? { entries: normalizeEntries(value.entries) } : {}),
    ...(nonEmptyString(value.favoriteId) ? { favoriteId: value.favoriteId.trim() } : {}),
    ...(QUICK_ACTION_PALETTES.includes(value.palette) ? { palette: value.palette } : {}),
    ...(typeof value.radialPagination === 'boolean' ? { radialPagination: value.radialPagination } : {}),
    ...(RADIAL_LAYOUTS.includes(value.radialLayout) ? { radialLayout: value.radialLayout } : {}),
    ...(selection && SELECTION_DISPLAYS.includes(value.selectionDisplay) ? { selectionDisplay: value.selectionDisplay } : {}),
    ...(selection && Number.isInteger(value.selectionActionLimit)
      ? { selectionActionLimit: clampSelectionLimit(value.selectionActionLimit) } : {}),
  };
  return Object.keys(own).length ? own : null;
}

// What a complete, normalized surface sets differently from `base`. A null
// favorite (none of the entries can be one) is left to resolve again.
const sameField = (field, a, b) => (field === 'entries' ? JSON.stringify(a) === JSON.stringify(b) : a === b);
function surfaceDiff(config, base) {
  return Object.fromEntries(OVERRIDE_FIELDS
    .filter(field => config[field] != null && !sameField(field, config[field], base[field]))
    .map(field => [field, config[field]]));
}

// A surface as a view shows it: All views, then what the view sets itself.
function resolvedSurface(normalized, key, surface) {
  const base = normalized.defaults[surface];
  const own = key && normalized.overrides[key]?.[surface];
  return own ? normalizeSurface({ ...base, ...own }, base) : base;
}

// Stores complete surface configs for one view as what each differs from All
// views. A surface left matching All views loses its override, and a view left
// with none is gone.
function writeScopeSurfaces(normalized, key, configs) {
  const scoped = { ...normalized.overrides[key] };
  for (const [surface, config] of Object.entries(configs)) {
    const base = normalized.defaults[surface];
    const own = surfaceDiff(normalizeSurface(config, base), base);
    if (Object.keys(own).length) scoped[surface] = own;
    else delete scoped[surface];
  }
  const overrides = { ...normalized.overrides, [key]: scoped };
  if (!Object.keys(scoped).length) delete overrides[key];
  return normalizeQuickActions({ ...normalized, overrides });
}

export function normalizeQuickActions(value) {
  const input = object(value) ? value : {};
  const defaultsInput = object(input.defaults) ? input.defaults : {};
  const defaults = Object.fromEntries(QUICK_ACTION_SURFACES.map(surface => [
    surface,
    normalizeSurface(defaultsInput[surface], DEFAULT_QUICK_ACTIONS.defaults[surface]),
  ]));
  const overridesInput = object(input.overrides) ? input.overrides : {};
  const overrides = {};
  Object.entries(overridesInput).slice(-100).forEach(([key, config]) => {
    if (!key || key.length > 2048 || !object(config)) return;
    const normalized = {};
    for (const surface of QUICK_ACTION_SURFACES) {
      const own = normalizeOverrideSurface(config[surface], surface);
      if (own) normalized[surface] = own;
    }
    if (Object.keys(normalized).length) overrides[key] = normalized;
  });
  const linksInput = object(input.styleLinks) ? input.styleLinks : {};
  const linkedOverrides = {};
  const candidateLinks = object(linksInput.overrides) ? linksInput.overrides : {};
  // A view linked while all its style matches All views has no override, and
  // stays linked. An unlink is only worth keeping next to an override.
  Object.entries(candidateLinks).slice(-100).forEach(([key, linked]) => {
    if (key && key.length <= 2048 && typeof linked === 'boolean' && (linked || key in overrides)) linkedOverrides[key] = linked;
  });
  return {
    defaults,
    overrides,
    styleLinks: { global: linksInput.global === true, overrides: linkedOverrides },
  };
}

export function quickActionScopeKey(scope) {
  if (!object(scope) || !scope.kind) return null;
  return JSON.stringify([
    String(scope.kind), scope.accountId ? String(scope.accountId) : null,
    scope.mailbox ? String(scope.mailbox) : null,
    scope.view === 'explorer' ? 'explorer' : 'list',
    scope.viewMode === 'local' || scope.viewMode === 'server' ? scope.viewMode : 'all',
    object(scope.mailboxScope) ? [scope.mailboxScope.root || null, Array.isArray(scope.mailboxScope.paths) ? scope.mailboxScope.paths : []] : null,
  ]);
}

export function currentQuickActionScope(state, settings = {}) {
  const mailbox = state?.activeMailbox || 'INBOX';
  const accountId = state?.activeAccountId || null;
  const view = settings.emailListView === 'explorer' ? 'explorer' : 'list';
  let kind = 'mailbox';
  if (state?.searchQuery || state?.searchTerm || state?.isSearchResults) kind = 'search';
  else if (mailbox === 'UNIFIED' || state?.unifiedInbox) kind = 'unified';
  else if (state?.mailboxScope) kind = 'subtree';
  else if (mailbox.toLowerCase() === 'archive' || state?.viewMode === 'local') kind = 'archive';
  return {
    kind,
    accountId: kind === 'unified' || (kind === 'search' && state?.unifiedInbox) ? null : accountId,
    mailbox: kind === 'unified' ? (state?.unifiedFolder || 'INBOX') : mailbox === 'UNIFIED' ? null : mailbox,
    ...(kind === 'subtree' ? { mailboxScope: state.mailboxScope } : {}),
    view,
    viewMode: state?.viewMode || 'all',
  };
}

// `inherited`: the view sets nothing of this surface itself.
export function resolveQuickActions(value, surface, scope = null) {
  const normalized = normalizeQuickActions(value);
  if (!QUICK_ACTION_SURFACES.includes(surface)) return { config: DEFAULT_QUICK_ACTIONS.defaults.row, inherited: true };
  const key = quickActionScopeKey(scope);
  return { config: resolvedSurface(normalized, key, surface), inherited: !(key && normalized.overrides[key]?.[surface]) };
}

// `config` is the whole surface as it should show; at a view, only what it
// sets differently from All views is stored.
export function setQuickActionSurface(value, surface, scope, config) {
  const normalized = normalizeQuickActions(value);
  if (!QUICK_ACTION_SURFACES.includes(surface)) return normalized;
  const key = quickActionScopeKey(scope);
  if (key) return writeScopeSurfaces(normalized, key, { [surface]: config });
  const nextConfig = normalizeSurface(config, normalized.defaults[surface]);
  return normalizeQuickActions({ ...normalized, defaults: { ...normalized.defaults, [surface]: nextConfig } });
}

/// Stores several surfaces of one view (`scope`, never All views) at once, as
/// setQuickActionSurface stores one. Surfaces not named keep what they had.
export function setQuickActionScopeSurfaces(value, scope, configs) {
  const normalized = normalizeQuickActions(value);
  const key = quickActionScopeKey(scope);
  if (!key) return normalized;
  const known = Object.fromEntries(Object.entries(configs || {}).filter(([surface]) => QUICK_ACTION_SURFACES.includes(surface)));
  return writeScopeSurfaces(normalized, key, known);
}

/// Applies `fn(surface, config, { scopeKey })` to every surface that holds a
/// list: each All-views surface (scopeKey null) and each view surface that
/// sets its own `entries`. A view surface without them inherits the All-views
/// list, so there is nothing of its own to change. Works on raw persisted
/// settings as well as normalized ones; every transform of saved lists (a new
/// action appended, a tag repointed) goes through here so no view is missed.
export function mapQuickActionSurfaces(value, fn) {
  if (!object(value)) return value;
  const mapGroup = (group, scopeKey) => Object.fromEntries(Object.entries(group).map(([surface, config]) => [
    surface,
    QUICK_ACTION_SURFACES.includes(surface) && object(config) && (scopeKey === null || Array.isArray(config.entries))
      ? fn(surface, config, { scopeKey })
      : config,
  ]));
  return {
    ...value,
    ...(object(value.defaults) ? { defaults: mapGroup(value.defaults, null) } : {}),
    ...(object(value.overrides) ? {
      overrides: Object.fromEntries(Object.entries(value.overrides).map(([key, scoped]) => [
        key, object(scoped) ? mapGroup(scoped, key) : scoped,
      ])),
    } : {}),
  };
}

/// Rewrites every view override as what it sets differently from All views.
/// Overrides saved before settings v15 were whole copies of each surface, so
/// nothing told a field the view chose from one copied from All views, and
/// every later All-views edit stopped at that view. Resolving then diffing is
/// also a no-op on an override that is already sparse, except for a field
/// that happens to equal All views now.
export function quickActionOverridesAsDiffs(value) {
  if (!object(value) || !object(value.overrides)) return value;
  const { defaults } = normalizeQuickActions({ defaults: value.defaults });
  const overrides = {};
  for (const [key, scoped] of Object.entries(value.overrides)) {
    if (!object(scoped)) continue;
    const own = {};
    for (const surface of QUICK_ACTION_SURFACES) {
      if (!(surface in scoped)) continue;
      const diff = surfaceDiff(normalizeSurface(scoped[surface], defaults[surface]), defaults[surface]);
      if (Object.keys(diff).length) own[surface] = diff;
    }
    if (Object.keys(own).length) overrides[key] = own;
  }
  return { ...value, overrides };
}

const STYLE_FIELDS = ['mode', 'palette', 'radialPagination', 'radialLayout'];
const copyStyle = (config, source) => ({
  ...config,
  ...Object.fromEntries(STYLE_FIELDS.map(field => [field, source[field]])),
});

export function isQuickActionStyleLinked(value, scope = null) {
  const normalized = normalizeQuickActions(value);
  const key = quickActionScopeKey(scope);
  return key ? normalized.styleLinks.overrides[key] === true : normalized.styleLinks.global;
}

export function setQuickActionStyleLink(value, scope, linked, sourceSurface = 'row') {
  const normalized = normalizeQuickActions(value);
  if (!QUICK_ACTION_SURFACES.includes(sourceSurface)) return normalized;
  const key = quickActionScopeKey(scope);
  const source = resolvedSurface(normalized, key, sourceSurface);
  const styleLinks = {
    ...normalized.styleLinks,
    ...(key
      ? { overrides: { ...normalized.styleLinks.overrides, [key]: linked === true } }
      : { global: linked === true }),
  };
  if (!linked) return normalizeQuickActions({ ...normalized, styleLinks });
  if (!key) {
    return normalizeQuickActions({
      ...normalized,
      styleLinks,
      defaults: Object.fromEntries(QUICK_ACTION_SURFACES.map(surface => [
        surface, copyStyle(normalized.defaults[surface], source),
      ])),
    });
  }
  return writeScopeSurfaces({ ...normalized, styleLinks }, key, Object.fromEntries(QUICK_ACTION_SURFACES.map(surface => [
    surface, copyStyle(resolvedSurface(normalized, key, surface), source),
  ])));
}

export function setQuickActionStyle(value, surface, scope, updates) {
  const normalized = normalizeQuickActions(value);
  if (!QUICK_ACTION_SURFACES.includes(surface)) return normalized;
  const key = quickActionScopeKey(scope);
  const current = resolvedSurface(normalized, key, surface);
  const source = normalizeSurface({ ...current, ...updates }, normalized.defaults[surface]);
  if (!isQuickActionStyleLinked(normalized, scope)) {
    return setQuickActionSurface(normalized, surface, scope, source);
  }
  if (!key) {
    return normalizeQuickActions({
      ...normalized,
      defaults: Object.fromEntries(QUICK_ACTION_SURFACES.map(name => [
        name, copyStyle(normalized.defaults[name], source),
      ])),
    });
  }
  return writeScopeSurfaces(normalized, key, Object.fromEntries(QUICK_ACTION_SURFACES.map(name => [
    name, copyStyle(resolvedSurface(normalized, key, name), source),
  ])));
}

export function resetQuickActionScope(value, scope, surface) {
  const normalized = normalizeQuickActions(value);
  const key = quickActionScopeKey(scope);
  // A linked view may have no override at all (its style matched All views),
  // and resetting it still unlinks it.
  if (!key || !(normalized.overrides[key] || key in normalized.styleLinks.overrides)) return normalized;
  const scoped = { ...normalized.overrides[key] };
  if (surface) delete scoped[surface];
  else for (const name of QUICK_ACTION_SURFACES) delete scoped[name];
  if (!Object.keys(scoped).length) delete normalized.overrides[key];
  else normalized.overrides[key] = scoped;
  // Resetting only one linked surface intentionally restores its inherited
  // behavior. Keep the link indicator truthful by unlinking this scope.
  if (surface && normalized.styleLinks.overrides[key]) {
    normalized.styleLinks = {
      ...normalized.styleLinks,
      overrides: { ...normalized.styleLinks.overrides, [key]: false },
    };
  }
  if (!surface) {
    const remainingLinks = { ...normalized.styleLinks.overrides };
    delete remainingLinks[key];
    normalized.styleLinks = { ...normalized.styleLinks, overrides: remainingLinks };
  }
  return normalizeQuickActions(normalized);
}

function actionLocation(email, state) {
  if (!email || !state) return null;
  const accountId = email._accountId || email._srcAccountId || state.activeAccountId;
  const mailbox = email._mailbox || (accountId === state.activeAccountId
    ? (email._fromSentFolder ? state.getSentMailboxPath?.() : state.activeMailbox)
    : null);
  return accountId && mailbox && mailbox !== 'UNIFIED' ? { accountId, mailbox } : null;
}

function actionSelectionKey(email, state) {
  const location = actionLocation(email, state);
  if (!location) return email?._accountId ? `${email._accountId}:${email._mailbox ?? ''}:${email.uid}` : email?.uid;
  const spans = state.activeMailbox === 'UNIFIED' || !!state.mailboxScope;
  if (!spans && location.accountId === state.activeAccountId && location.mailbox === state.activeMailbox) return email.uid;
  return `${location.accountId}:${location.mailbox}:${email.uid}`;
}

// Selection may outlive the rows currently loaded into the virtual window.
// Account-targeted operations need every selected identity resolved before a
// folder choice can be considered safe.
export function resolveQuickActionSelectionTarget(keys, emails, state) {
  if (!Array.isArray(keys) || !keys.length || !Array.isArray(emails)) return null;
  const rowsByKey = new Map(emails.map(email => [actionSelectionKey(email, state), email]));
  const rows = keys.map(key => rowsByKey.get(key));
  if (rows.some(row => !row)) return null;
  const locations = rows.map(row => actionLocation(row, state));
  if (locations.some(location => !location)) return null;
  const accountIds = new Set(locations.map(location => location.accountId));
  if (accountIds.size !== 1) return null;
  return {
    accountId: locations[0].accountId,
    mailbox: locations.every(location => location.mailbox === locations[0].mailbox) ? locations[0].mailbox : null,
    emails: rows,
    locations,
  };
}
