export const QUICK_ACTION_SURFACES = ['row', 'selection', 'reader'];
export const QUICK_ACTION_MODES = ['inline', 'menu', 'radial', 'favorite-menu'];
export const QUICK_ACTION_PALETTES = ['neutral', 'semantic', 'custom'];
export const QUICK_ACTION_TYPES = [
  'archive', 'unarchive', 'delete', 'deleteServer', 'deleteEverywhere',
  'toggleRead', 'markRead', 'markUnread', 'star', 'unstar', 'tag', 'move',
  'spam', 'reply', 'replyAll', 'forward', 'replyTemplate', 'export', 'newMessage',
  'open', 'source', 'theme',
];

const entry = (action, extra = {}) => ({ id: action, action, ...extra });
export const DEFAULT_QUICK_ACTIONS = {
  defaults: {
    row: {
      mode: 'favorite-menu',
      entries: [
        entry('archive'), entry('unarchive'), entry('toggleRead'), entry('star'), entry('unstar'),
        entry('reply'), entry('replyAll'), entry('forward'), entry('newMessage'), entry('move'),
        entry('spam'), entry('deleteServer'), entry('deleteEverywhere'), entry('export'),
      ],
      favoriteId: 'archive', palette: 'semantic', radialPagination: false,
    },
    selection: {
      mode: 'inline',
      entries: ['markRead', 'markUnread', 'archive', 'unarchive', 'move', 'deleteServer', 'deleteEverywhere', 'export']
        .map(action => entry(action)),
      favoriteId: 'archive', palette: 'semantic', radialPagination: false,
      selectionDisplay: 'icon-label', selectionActionLimit: 3,
    },
    reader: {
      mode: 'inline',
      entries: ['reply', 'replyAll', 'forward', 'archive', 'delete', 'move', 'toggleRead', 'star', 'export', 'open', 'source', 'theme']
        .map(action => entry(action)),
      favoriteId: 'reply', palette: 'semantic', radialPagination: false,
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
const cloneSurface = value => ({
  ...value,
  entries: (value.entries || []).map(item => ({ ...item, ...(item.params ? { params: { ...item.params } } : {}) })),
});
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

function normalizeSurface(value, fallback) {
  if (!object(value)) return cloneSurface(fallback);
  const hasEntries = Array.isArray(value.entries);
  const entries = hasEntries ? value.entries.map(normalizeEntry).filter(Boolean) : cloneSurface(fallback).entries;
  const unique = [];
  const seen = new Set();
  for (const item of entries) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    unique.push(item);
  }
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
    ...(fallback.selectionDisplay ? {
      selectionDisplay: ['icon-label', 'icon-only'].includes(value.selectionDisplay) ? value.selectionDisplay : fallback.selectionDisplay,
      selectionActionLimit: Number.isInteger(value.selectionActionLimit)
        ? Math.max(1, Math.min(6, value.selectionActionLimit)) : fallback.selectionActionLimit,
    } : {}),
  };
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
      if (surface in config) normalized[surface] = normalizeSurface(config[surface], defaults[surface]);
    }
    if (Object.keys(normalized).length) overrides[key] = normalized;
  });
  const linksInput = object(input.styleLinks) ? input.styleLinks : {};
  const linkedOverrides = {};
  const candidateLinks = object(linksInput.overrides) ? linksInput.overrides : {};
  Object.entries(candidateLinks).slice(-100).forEach(([key, linked]) => {
    if (key && key.length <= 2048 && key in overrides && typeof linked === 'boolean') linkedOverrides[key] = linked;
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

export function resolveQuickActions(value, surface, scope = null) {
  const normalized = normalizeQuickActions(value);
  const key = quickActionScopeKey(scope);
  const scoped = key && normalized.overrides[key]?.[surface];
  return { config: scoped || normalized.defaults[surface] || DEFAULT_QUICK_ACTIONS.defaults.row, inherited: !scoped };
}

export function setQuickActionSurface(value, surface, scope, config) {
  const normalized = normalizeQuickActions(value);
  if (!QUICK_ACTION_SURFACES.includes(surface)) return normalized;
  const key = quickActionScopeKey(scope);
  const nextConfig = normalizeSurface(config, normalized.defaults[surface]);
  if (!key) return normalizeQuickActions({ ...normalized, defaults: { ...normalized.defaults, [surface]: nextConfig } });
  const overrides = { ...normalized.overrides, [key]: { ...normalized.overrides[key], [surface]: nextConfig } };
  return normalizeQuickActions({ ...normalized, overrides });
}

const STYLE_FIELDS = ['mode', 'palette', 'radialPagination'];
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
  const source = key && normalized.overrides[key]?.[sourceSurface]
    ? normalized.overrides[key][sourceSurface]
    : normalized.defaults[sourceSurface];
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
  const scoped = normalized.overrides[key] || {};
  return normalizeQuickActions({
    ...normalized,
    styleLinks,
    overrides: {
      ...normalized.overrides,
      [key]: Object.fromEntries(QUICK_ACTION_SURFACES.map(surface => [
        surface,
        copyStyle(scoped[surface] || normalized.defaults[surface], source),
      ])),
    },
  });
}

export function setQuickActionStyle(value, surface, scope, updates) {
  const normalized = normalizeQuickActions(value);
  if (!QUICK_ACTION_SURFACES.includes(surface)) return normalized;
  const key = quickActionScopeKey(scope);
  const current = key && normalized.overrides[key]?.[surface]
    ? normalized.overrides[key][surface]
    : normalized.defaults[surface];
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
  const scoped = normalized.overrides[key] || {};
  return normalizeQuickActions({
    ...normalized,
    overrides: {
      ...normalized.overrides,
      [key]: Object.fromEntries(QUICK_ACTION_SURFACES.map(name => [
        name, copyStyle(scoped[name] || normalized.defaults[name], source),
      ])),
    },
  });
}

export function resetQuickActionScope(value, scope, surface) {
  const normalized = normalizeQuickActions(value);
  const key = quickActionScopeKey(scope);
  if (!key || !normalized.overrides[key]) return normalized;
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
  return normalized;
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
