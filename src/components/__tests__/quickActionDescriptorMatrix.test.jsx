// @vitest-environment jsdom

// Characterization matrix: what every quick-action surface hands QuickActions
// (row menu, row swipe, selection bar, reader toolbar under each host's own
// handler set) for every action over a spread of targets. The snapshot was
// generated from the code, not written by hand; a change to it is a change in
// behavior and should name the cells it flips.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { create } from 'zustand';
import {
  AlarmClock, Archive, ArchiveRestore, Code, ExternalLink, FileText, FolderInput, Forward, ImageDown,
  Mail, MailOpen, MailPlus, MailX, Moon, Reply, ReplyAll, ShieldAlert, ShieldX, Star, Sun, Tag, Trash2,
} from 'lucide-react';

const mocks = vi.hoisted(() => ({ configs: {}, calls: [], registered: new Map(), foldersByAccount: {}, searchResults: [] }));

vi.mock('../QuickActions', () => ({
  QuickActions: props => { mocks.calls.push(props); return null; },
}));
vi.mock('../../hooks/useQuickActionConfiguration', () => ({
  useQuickActionConfiguration: surface => ({ config: mocks.configs[surface], scope: null }),
}));
vi.mock('../../i18n/index.js', async importOriginal => {
  const actual = await importOriginal();
  const t = (key, vars) => (vars === undefined ? key : `${key}${JSON.stringify(vars)}`);
  return { ...actual, t, useT: () => t };
});
vi.mock('framer-motion', () => ({
  motion: new Proxy({}, {
    get: () => React.forwardRef(({ children, initial, animate, exit, transition, ...props }, ref) => React.createElement('div', { ...props, ref }, children)),
  }),
  AnimatePresence: ({ children }) => children,
}));
vi.mock('../../utils/rowActionRegistry', async importOriginal => {
  const actual = await importOriginal();
  return {
    ...actual,
    registerRowActions: (node, ref) => {
      if (node) mocks.registered.set(node, ref);
      actual.registerRowActions(node, ref);
    },
  };
});
vi.mock('../MoveToFolderDropdown', () => ({ MoveToFolderDropdown: () => null }));
vi.mock('../SnoozePicker', () => ({ SnoozePicker: () => null }));
vi.mock('../DeleteConfirmModal', () => ({ DeleteConfirmModal: () => null }));
vi.mock('../email/MessageStateIcon', () => ({ useBackupScan: () => null, isBackedUp: email => email?._backedUp === true }));
vi.mock('../../services/cacheManager', () => ({ getAccountCacheMailboxes: accountId => mocks.foldersByAccount[accountId] }));
vi.mock('../../services/workflows/messageMutations', () => ({
  reloadListInView: vi.fn(), setDeleteUndo: vi.fn(), moveEmails: vi.fn(),
}));
vi.mock('../../utils/composeOpener', () => ({ openCompose: vi.fn() }));
vi.mock('../../utils/replyTarget', () => ({ replyTarget: vi.fn() }));
vi.mock('../../stores/exportStore', () => ({ useExportStore: { getState: () => ({ openExport: vi.fn() }) } }));

const mailStore = create(() => ({}));
vi.mock('../../stores/mailStore', () => ({
  useMailStore: Object.assign(selector => mailStore(selector), {
    getState: () => mailStore.getState(),
    setState: patch => mailStore.setState(patch),
  }),
}));
const settingsStore = create(() => ({}));
vi.mock('../../stores/settingsStore', () => ({
  useSettingsStore: Object.assign(selector => settingsStore(selector), { getState: () => settingsStore.getState() }),
}));
const tagStore = create(() => ({}));
vi.mock('../../stores/tagStore', () => ({
  useTagStore: Object.assign(selector => tagStore(selector), { getState: () => tagStore.getState() }),
}));
vi.mock('../../stores/searchStore', () => ({
  useSearchStore: Object.assign(selector => selector({ searchResults: mocks.searchResults }), {
    getState: () => ({ searchResults: mocks.searchResults }),
  }),
}));

const { RowQuickActions } = await import('../RowQuickActions');
const { SelectionActionBar, SelectionActionBarView } = await import('../SelectionActionBar');
const { EmailActionBar } = await import('../email/EmailActionBar');
const { QUICK_ACTION_SURFACE_ACTIONS, QUICK_ACTION_TYPES, DEFAULT_QUICK_ACTIONS } = await import('../../utils/quickActions');
const { FilledStar } = await import('../../utils/quickActionIcons');
const { resolveEmailLocation, selectionKey, vaultKey } = await import('../../stores/slices/unifiedHelpers');
const { describePurge } = await import('../../utils/custodyCopy');
const { isOutgoingMailboxName } = await import('../../utils/sentFolder');

const ICONS = new Map(Object.entries({
  AlarmClock, Archive, ArchiveRestore, Code, ExternalLink, FileText, FolderInput, Forward, ImageDown,
  Mail, MailOpen, MailPlus, MailX, Moon, Reply, ReplyAll, ShieldAlert, ShieldX, Star, Sun, Tag, Trash2, FilledStar,
}).map(([name, Icon]) => [Icon, name]));
const iconName = Icon => (Icon === undefined ? undefined : ICONS.get(Icon) || `UNKNOWN:${Icon?.displayName || Icon?.name}`);

const KNOWN_KEYS = new Set(['id', 'action', 'label', 'titleLabel', 'Icon', 'hidden', 'disabled', 'tone', 'isDestructive',
  'restoreFocus', 'buttonRef', 'expanded', 'onActivate']);
// One line per descriptor, so a behavior change reads as a changed line.
const line = d => JSON.stringify({
  id: d.id, action: d.action, label: d.label, titleLabel: d.titleLabel, icon: iconName(d.Icon),
  hidden: d.hidden, disabled: d.disabled, tone: d.tone, isDestructive: d.isDestructive, restoreFocus: d.restoreFocus,
  expanded: d.expanded, buttonRef: d.buttonRef ? true : undefined,
  extraKeys: Object.keys(d).filter(key => !KNOWN_KEYS.has(key)).join(',') || undefined,
});
// Every distinct QuickActions render: re-renders with the same props collapse.
const captured = () => [...new Set(mocks.calls.map(props => JSON.stringify({
  surface: props.surface,
  entries: props.config?.entries?.map(entry => entry.id).join(' '),
  descriptors: props.descriptors.map(line),
})))].map(text => JSON.parse(text));

// ── Fixtures ────────────────────────────────────────────────────────────────
const folder = (path, extra = {}) => ({ name: path, path, ...extra });
const FOLDERS_A = [folder('INBOX'), folder('Archive'), folder('Junk', { specialUse: '\\Junk' }), folder('Parent', { noselect: true }), folder('Sent', { specialUse: '\\Sent' })];
const FOLDERS = {
  'acct-b': [folder('INBOX'), folder('Archive'), folder('Spam', { specialUse: '\\Junk' }), folder('Parent', { noselect: true })],
  'acct-c': [folder('INBOX'), folder('Archive'), folder('Parent', { noselect: true })],
  'acct-g': [folder('INBOX'), folder('Archive'), folder('Junk', { specialUse: '\\Junk' })],
};
const ACCOUNTS = [{ id: 'acct-a' }, { id: 'acct-b' }, { id: 'acct-c' }, { id: 'acct-g', oauth2Transport: 'graph' }];

function baseMailState(overrides = {}) {
  return {
    activeAccountId: 'acct-a', activeMailbox: 'INBOX', mailboxScope: null, accounts: ACCOUNTS, mailboxes: FOLDERS_A,
    localFolders: { 'acct-a': [{ name: 'Imported', dir: 'Imported' }] },
    getSentMailboxPath: () => 'Sent',
    selectedEmailIds: new Set(), archivedEmailIds: new Set(),
    emails: [], sortedEmails: [], localEmails: [], sentEmails: [],
    getSelectionSummary: () => ({ threads: 1, emails: 1 }),
    setSelection: vi.fn(), markSelectedAsRead: vi.fn(), markSelectedAsUnread: vi.fn(), setSelectedFlagged: vi.fn(),
    purgeSelectedEverywhere: vi.fn(), moveEmails: vi.fn(), clearSelection: vi.fn(), saveSelectedLocally: vi.fn(),
    deleteSelectedFromServer: vi.fn(), removeLocalEmails: vi.fn(),
    ...overrides,
  };
}

let day = 0;
const mk = (uid, overrides = {}) => ({
  uid, messageId: `<m${uid}@x.test>`, subject: `Message ${uid}`, date: `2026-08-${String(++day).padStart(2, '0')}T10:00:00Z`,
  from: { address: 'sender@x.test', name: 'Sender' }, to: [{ address: 'me@x.test' }, { address: 'you@x.test' }], cc: [],
  flags: [], isArchived: false, source: 'server', _accountId: 'acct-a', _mailbox: 'INBOX',
  ...overrides,
});
const E = {
  unread: mk(1),
  read: mk(2, { flags: ['\\Seen'] }),
  flagged: mk(3, { flags: ['\\Flagged'] }),
  readFlagged: mk(4, { flags: ['\\Seen', '\\Flagged'] }),
  archived: mk(5, { flags: ['\\Seen'], isArchived: true }),
  backedUp: mk(6, { flags: ['\\Seen'], isArchived: true, _backedUp: true }),
  localOnly: mk(7, { flags: ['\\Seen'], isArchived: true, source: 'local-only' }),
  localFolder: mk(8, { flags: ['\\Seen'], _mailbox: 'Imported' }),
  insightsReadOnly: mk(9, { flags: ['\\Seen'], _insightsReadOnly: true }),
  insightsNoServer: mk(10, { flags: ['\\Seen'], _insightsNoServerActions: true }),
  otherAccount: mk(11, { flags: ['\\Seen'], _accountId: 'acct-b' }),
  otherAccountArchived: mk(12, { flags: ['\\Seen'], _accountId: 'acct-b', isArchived: true }),
  unresolved: mk(13, { flags: ['\\Seen'], _accountId: 'acct-b', _mailbox: undefined }),
  noJunk: mk(14, { flags: ['\\Seen'], _accountId: 'acct-c' }),
  graph: mk(15, { flags: ['\\Seen'], _accountId: 'acct-g' }),
  noMessageId: mk(16, { flags: ['\\Seen'], messageId: undefined }),
  unsubscribe: mk(17, { flags: ['\\Seen'], listUnsubscribe: '<mailto:u@x.test>' }),
  sent: mk(18, { flags: ['\\Seen'], _mailbox: 'Sent' }),
  singleRecipient: mk(19, { flags: ['\\Seen'], to: [{ address: 'me@x.test' }] }),
  noSender: mk(20, { flags: ['\\Seen'], from: { address: '', name: '' } }),
  otherMailbox: mk(21, { flags: ['\\Seen'], _mailbox: 'Archive' }),
};
const SINGLES = Object.keys(E).map(name => [`single:${name}`, [name]]);
const THREADS = [
  ['thread:unread+read', ['unread', 'read']],
  ['thread:read+read', ['read', 'readFlagged']],
  ['thread:unread+unread', ['unread', 'flagged']],
  ['thread:flagged+flagged', ['flagged', 'readFlagged']],
  ['thread:archived+unarchived', ['archived', 'read']],
  ['thread:archived+archived', ['archived', 'backedUp']],
  ['thread:server+localOnly', ['read', 'localOnly']],
  ['thread:localFolder+server', ['localFolder', 'read']],
  ['thread:multiAccount', ['read', 'otherAccount']],
  ['thread:unresolved', ['read', 'unresolved']],
  ['thread:twoMailboxes', ['read', 'otherMailbox']],
  ['thread:unsubscribe', ['read', 'unsubscribe']],
  ['thread:insights', ['read', 'insightsReadOnly']],
  ['thread:snoozeMixed', ['read', 'noMessageId']],
  ['thread:otherAccount', ['otherAccount', 'otherAccountArchived']],
];
const TARGETS = [...SINGLES, ...THREADS];

const entry = (action, params) => ({ id: action, action, ...(params ? { params } : {}) });
const VARIANTS = {
  tag: [['tag:existing', { tagId: 'tag-1' }], ['tag:missing', { tagId: 'tag-gone' }]],
  move: [
    ['move:existing', { mailbox: 'Archive' }], ['move:missing', { mailbox: 'Nowhere' }], ['move:noselect', { mailbox: 'Parent' }],
    ['move:ownAccount', { mailbox: 'Archive', accountId: 'acct-a' }], ['move:otherAccount', { mailbox: 'Archive', accountId: 'acct-b' }],
  ],
  replyTemplate: [['replyTemplate:existing', { templateId: 'tpl-1' }], ['replyTemplate:missing', { templateId: 'tpl-gone' }]],
};
function surfaceConfig(surface, drop = []) {
  const actions = QUICK_ACTION_SURFACE_ACTIONS[surface].filter(action => !drop.includes(action));
  return {
    mode: 'inline', palette: 'neutral', favoriteId: null, radialPagination: false, radialLayout: 'flat',
    selectionDisplay: 'icon-label', selectionActionLimit: 3,
    entries: [
      ...actions.map(action => entry(action)),
      ...actions.flatMap(action => (VARIANTS[action] || []).map(([id, params]) => ({ id, action, params }))),
    ],
  };
}

beforeEach(() => {
  mocks.calls = [];
  mocks.registered = new Map();
  mocks.foldersByAccount = FOLDERS;
  mocks.searchResults = [];
  mailStore.setState(baseMailState(), true);
  settingsStore.setState({
    emailTemplates: [{ id: 'tpl-1', name: 'Thanks', body: '<p>Thanks</p>' }],
    composeOpenMode: 'inline', actionButtonDisplay: 'icon-label',
  }, true);
  tagStore.setState({ tags: [{ id: 'tag-1', name: 'Work' }], applyTag: vi.fn(), applyTagToRows: vi.fn() }, true);
});
afterEach(cleanup);

const rows = names => names.map(name => E[name]);
const NOOP = () => {};

// ── Row ─────────────────────────────────────────────────────────────────────
const ROW_PROPS = {
  default: { onRequestDelete: NOOP, disabled: false },
  saving: { onRequestDelete: NOOP, disabled: true },
  noRequestDelete: { disabled: false },
};
const ROW_CASES = [
  ...TARGETS.map(([name, targets]) => [`${name} | default`, targets, 'default']),
  ['single:read | saving', ['read'], 'saving'],
  ['single:read | noRequestDelete', ['read'], 'noRequestDelete'],
  ['single:archived | noRequestDelete', ['archived'], 'noRequestDelete'],
  ['thread:unread+read | noRequestDelete', ['unread', 'read'], 'noRequestDelete'],
];
const ACTIONS = { deleteEmailFromServer: NOOP, removeLocalEmails: NOOP, saveEmailsLocally: NOOP };

function renderRow(targets, props) {
  mocks.configs.row = surfaceConfig('row');
  return render(<RowQuickActions emails={rows(targets)} actions={ACTIONS} identity="row" {...ROW_PROPS[props]} />);
}

describe('row menu', () => {
  it.each(ROW_CASES)('%s', (_name, targets, props) => {
    renderRow(targets, props);
    expect(captured()).toMatchSnapshot();
  });
});

describe('row swipe', () => {
  it.each(TARGETS)('%s', (_name, targets) => {
    const { container } = renderRow(targets, 'default');
    const describeEntry = mocks.registered.get(container.querySelector('[data-row-actions]'))?.current;
    expect(typeof describeEntry).toBe('function');
    expect(QUICK_ACTION_TYPES.map(action => line(describeEntry({ id: action, action })))).toMatchSnapshot();
  });
});

// ── Selection ───────────────────────────────────────────────────────────────
describe('selection view (Settings sample: rows only)', () => {
  it.each(TARGETS)('%s', (_name, targets) => {
    render(<SelectionActionBarView rows={rows(targets)} config={surfaceConfig('selection')} preview />);
    expect(captured()).toMatchSnapshot();
  });
  // Normalization keeps any known action on any surface, so a saved selection
  // list can name one the bar never offers (reply, open, ...).
  it.each([['single:read', ['read']], ['thread:unread+read', ['unread', 'read']]])('%s | every action type', (_name, targets) => {
    const config = { ...surfaceConfig('selection'), entries: QUICK_ACTION_TYPES.map(action => entry(action)) };
    render(<SelectionActionBarView rows={rows(targets)} config={config} preview />);
    expect(captured()).toMatchSnapshot();
  });
});

// The live bar: keys from the store, rows out of every pool, archived state
// out of `archivedEmailIds` by accountId:mailbox:uid.
function renderSelection(selected, { state = {}, pools = selected, search = [], extraKeys = [] } = {}) {
  mocks.configs.selection = surfaceConfig('selection');
  mailStore.setState(baseMailState(state), true);
  const live = mailStore.getState();
  mailStore.setState({
    sortedEmails: pools, emails: pools,
    selectedEmailIds: new Set([...selected.map(email => selectionKey(email, live)), ...extraKeys]),
    archivedEmailIds: new Set([...pools, ...search].filter(email => email.isArchived).map(email => vaultKey(email._accountId ?? 'acct-a', email._mailbox ?? 'INBOX', email.uid))),
    getSelectionSummary: () => ({ threads: selected.length + extraKeys.length, emails: selected.length + extraKeys.length }),
  });
  mocks.searchResults = search;
  render(<SelectionActionBar />);
}

describe('selection bar (store)', () => {
  it.each(TARGETS)('%s', (_name, targets) => {
    renderSelection(rows(targets));
    expect(captured()).toMatchSnapshot();
  });
  it('partial: a selected key no pool resolves', () => {
    renderSelection(rows(['read']), { extraKeys: ['acct-a:INBOX:999'] });
    expect(captured()).toMatchSnapshot();
  });
  it('search-only row', () => {
    renderSelection(rows(['read']), { pools: [], search: rows(['read']) });
    expect(captured()).toMatchSnapshot();
  });
  it('spanning view, archived row', () => {
    renderSelection(rows(['archived']), { state: { activeMailbox: 'UNIFIED' } });
    expect(captured()).toMatchSnapshot();
  });
  it('spanning view, mixed read', () => {
    renderSelection(rows(['unread', 'read']), { state: { activeMailbox: 'UNIFIED' } });
    expect(captured()).toMatchSnapshot();
  });
});

// ── Reader ──────────────────────────────────────────────────────────────────
// Each host's handler set and derived props, mirrored from its <EmailActionBar>.
const handlers = names => Object.fromEntries(names.map(name => [name, NOOP]));
const moveButtonRef = { current: null };
const isSent = (email, location) => isOutgoingMailboxName(location?.mailbox) || !!email.flags?.includes('\\Sent');
const singleRecipientOf = email => (email.to || []).length <= 1 && !(email.cc?.length > 0);
const HOSTS = {
  // EmailViewer.jsx
  viewer: (email, { dark = false, busy = false, moveOpen = false } = {}) => {
    const location = resolveEmailLocation(email, mailStore.getState());
    return {
      variant: 'single',
      ...handlers(['onReply', 'onReplyAll', 'onForward', 'onArchive', 'onDelete', 'onMove', 'onToggleRead', 'onToggleFlag',
        'onDeleteEverywhere', 'onOpenInWindow', 'onViewSource', 'onExport', 'onToggleEmailTheme', 'onActionStart']),
      emailThemeDark: dark,
      isArchived: typeof email.isArchived === 'boolean' ? email.isArchived : false,
      isRead: email.flags?.includes('\\Seen'),
      isLocalOnly: email.source === 'local-only',
      isSentEmail: isSent(email, location),
      singleRecipient: singleRecipientOf(email),
      disabled: { delete: busy, toggleRead: busy, archive: busy, compose: busy },
      moveDropdownOpen: moveOpen, moveButtonRef,
    };
  },
  // ThreadView.jsx (ThreadEmailItem)
  thread: email => {
    const location = resolveEmailLocation(email, mailStore.getState());
    const localOnly = email.source === 'local-only';
    return {
      variant: 'thread',
      ...handlers(['onReply', 'onReplyAll', 'onForward', 'onArchive', 'onDelete', 'onDeleteEverywhere', 'onMove', 'onToggleRead',
        'onToggleFlag', 'onExport', 'onOpenInWindow', 'onViewSource', 'onToggleEmailTheme', 'onActionStart']),
      emailThemeDark: false,
      isArchived: typeof email.isArchived === 'boolean' ? email.isArchived : false,
      isRead: !!email.flags?.includes('\\Seen'),
      isLocalOnly: localOnly,
      isSentEmail: isSent(email, location),
      singleRecipient: singleRecipientOf(email),
      disabled: { archive: false, move: !location || localOnly, toggleRead: !location || localOnly, toggleFlag: !location || localOnly },
      moveButtonRef, moveDropdownOpen: false,
    };
  },
  // ChatBubbleView.jsx
  chat: email => {
    const location = resolveEmailLocation(email, mailStore.getState());
    const isArchived = !!email.isArchived;
    const isLocalOnly = email.source === 'local-only' || email._origin === 'local-only';
    const purge = location && describePurge({ server: !isLocalOnly, vault: isArchived || isLocalOnly, backup: false }, 1);
    return {
      variant: 'chat',
      ...handlers(['onReply', 'onReplyAll', 'onForward', 'onArchive', 'onDelete', 'onMove', 'onToggleRead', 'onToggleFlag',
        'onExport', 'onOpenInWindow', 'onMenuOpenChange']),
      onDeleteEverywhere: purge ? NOOP : null,
      onViewSource: null,
      isArchived, isRead: !!email.flags?.includes('\\Seen'), isLocalOnly,
      isSentEmail: isSent(email, location),
      singleRecipient: false,
      disabled: { archive: !location, delete: !location },
      moveButtonRef, moveDropdownOpen: false,
    };
  },
  // FullViewEmailModal.jsx
  fullView: email => {
    const location = resolveEmailLocation(email, mailStore.getState());
    const isArchived = !!email.isArchived;
    const isLocalOnly = email.source === 'local-only' || email._origin === 'local-only';
    const purge = describePurge({ server: !isLocalOnly, vault: isArchived || isLocalOnly, backup: false }, 1);
    return {
      variant: 'single',
      ...handlers(['onReply', 'onReplyAll', 'onForward', 'onArchive', 'onDelete', 'onMove', 'onToggleRead', 'onToggleFlag',
        'onExport', 'onToggleEmailTheme']),
      onDeleteEverywhere: purge && location ? NOOP : null,
      emailThemeDark: false, isArchived, isRead: !!email.flags?.includes('\\Seen'), isLocalOnly,
      isSentEmail: isSent(email, location),
      singleRecipient: singleRecipientOf(email),
      disabled: { archive: !location, delete: !location },
      moveButtonRef, moveDropdownOpen: false,
    };
  },
  // settings/QuickActionSamples.jsx
  samples: email => ({
    variant: 'single', preview: true, onActionPreview: NOOP,
    ...handlers(['onReply', 'onReplyAll', 'onForward', 'onArchive', 'onDelete', 'onDeleteEverywhere', 'onMove',
      'onToggleRead', 'onToggleFlag', 'onSpam', 'onApplyLocalLabel', 'onReplyTemplate', 'onOpenInWindow',
      'onViewSource', 'onExport', 'onToggleEmailTheme']),
    isArchived: !!email.isArchived, isRead: !!email.flags?.includes('\\Seen'),
    isLocalOnly: false, isSentEmail: false, singleRecipient: false,
  }),
};
const READER_CONFIGS = {
  all: () => surfaceConfig('reader'),
  // No explicit Unstar / Unarchive: Star and Archive toggle.
  toggles: () => surfaceConfig('reader', ['unstar', 'unarchive']),
  defaults: () => DEFAULT_QUICK_ACTIONS.defaults.reader,
};
const READER_CASES = [
  ...Object.keys(HOSTS).flatMap(host => Object.keys(E)
    // ThreadView draws no bar at all on a read-only (insights) thread.
    .filter(name => host !== 'thread' || !name.startsWith('insights'))
    .map(name => [`${host} | all | ${name}`, host, 'all', name, {}])),
  ...['viewer', 'chat'].flatMap(host => Object.keys(E).map(name => [`${host} | toggles | ${name}`, host, 'toggles', name, {}])),
  ...['viewer', 'chat'].flatMap(host => ['read', 'archived', 'flagged'].map(name => [`${host} | defaults | ${name}`, host, 'defaults', name, {}])),
  ['viewer | all | read | dark', 'viewer', 'all', 'read', { dark: true }],
  ['viewer | all | read | busy', 'viewer', 'all', 'read', { busy: true }],
  ['viewer | all | read | moveOpen', 'viewer', 'all', 'read', { moveOpen: true }],
];

describe('reader', () => {
  it.each(READER_CASES)('%s', (_name, host, configName, fixture, options) => {
    const config = READER_CONFIGS[configName]();
    mocks.configs.reader = config;
    const email = E[fixture];
    const props = HOSTS[host](email, options);
    render(<EmailActionBar email={email} {...props} {...(host === 'samples' ? { configOverride: config } : {})} />);
    expect(captured()).toMatchSnapshot();
  });
});
