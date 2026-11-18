// @vitest-environment jsdom
// Settings > Appearance > Quick actions and the viewer bar it drives (`quickActionsReader`): the
// bar shows the listed actions in order, More the rest; the desktop presets map onto the phone's
// actions the way a desktop import does (transfer.rs `phone_reader_actions`, same fixture).
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { t } from '../i18n.js';

const engine = vi.hoisted(() => ({ calls: [], prefs: {} }));

vi.mock('../transport.js', () => ({
  daemonCall: vi.fn(async (method, params = {}) => {
    engine.calls.push([method, params]);
    switch (method) {
      case 'mobile.prefs.set':
        engine.prefs = { ...engine.prefs, ...params };
        return { ...engine.prefs };
      case 'mobile.message.body':
        return { html: '<p>Hi</p>', text: null, attachments: [], remoteImages: 0, trackers: 0, gone: false };
      default:
        throw Object.assign(new Error(method), { code: 'UNSUPPORTED' });
    }
  }),
  listen: vi.fn(() => () => {}),
  openFile: vi.fn(async () => {}),
  shareFile: vi.fn(async () => {}),
}));

const { default: Viewer } = await import('../Viewer.jsx');
const { default: Settings } = await import('../Settings.jsx');
const { useMobileStore } = await import('../store.js');
const { PREF_DEFAULTS } = await import('../prefs.js');
const qa = await import('../quickActions.js');

const row = { uid: 7, subject: 'Hi', fromName: 'Ada', fromAddress: 'ada@example.test', to: [], dateMs: Date.UTC(2026, 10, 3), seen: false, flagged: false };
const FOLDERS = [
  { path: 'INBOX', name: 'INBOX', depth: 0 },
  { path: 'Junk', name: 'Junk', depth: 0, specialUse: '\\Junk' },
];
const tools = () => [...document.querySelectorAll('.mv-viewer__toolbar [data-mv-tool]')].map((b) => b.getAttribute('data-mv-tool'));
const moreActions = () => [...document.querySelectorAll('[data-mv-more-action]')].map((b) => b.getAttribute('data-mv-more-action'));
const sets = () => engine.calls.filter(([m]) => m === 'mobile.prefs.set').map(([, p]) => p);
const flush = () => act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); });
const withBar = (quickActionsReader) => useMobileStore.setState({ prefs: { ...PREF_DEFAULTS, quickActionsReader } });

beforeEach(() => {
  engine.calls = [];
  engine.prefs = { ...PREF_DEFAULTS };
  useMobileStore.setState({ prefs: PREF_DEFAULTS });
});
afterEach(cleanup);

describe('quickActions.js', () => {
  it('keeps the phone actions only, once each, at most four', () => {
    expect(qa.readerBar(['reply', 'archive', 'reply', 'flag', 'spam', 'move', 'delete'])).toEqual(['reply', 'flag', 'spam', 'move']);
    expect(qa.readerBar('reply')).toEqual([]);
    expect(PREF_DEFAULTS.quickActionsReader).toEqual(qa.DEFAULT_READER_BAR);
  });

  it('maps a desktop reader set as the import does', () => {
    expect(qa.fromDesktop(['archive', 'spam', 'delete', 'toggleRead', 'move', 'snooze', 'reply', 'replyAll', 'forward']))
      .toEqual(['spam', 'delete', 'toggleRead', 'move']);
    expect(qa.fromDesktop(['star', 'unstar', 'markRead', 'markUnread', 'deleteServer', 'export', 'deleteEverywhere']))
      .toEqual(['flag', 'toggleRead', 'delete']);
  });

  it('offers the desktop presets, MailVault being the phone default, and names the one in use', () => {
    const bars = Object.fromEntries(qa.READER_PRESETS.map((p) => [p.id, p.bar]));
    expect(bars).toEqual({
      mailvault: ['toggleRead', 'flag', 'move', 'delete'],
      gmail: ['spam', 'delete', 'toggleRead', 'move'],
      outlook: ['reply', 'replyAll', 'forward', 'delete'],
      thunderbird: ['reply', 'replyAll', 'forward', 'spam'],
    });
    expect(qa.activeReaderPreset(PREF_DEFAULTS.quickActionsReader)).toBe('mailvault');
    expect(qa.activeReaderPreset(['reply'])).toBe(null);
  });

  it('puts every other action under More and leaves out what the message cannot take', () => {
    expect(qa.splitReader(['reply', 'spam'], (a) => a !== 'spam')).toEqual({
      bar: ['reply'], more: ['toggleRead', 'flag', 'move', 'delete', 'replyAll', 'forward'],
    });
  });
});

describe('viewer bar', () => {
  const view = (props = {}) => render(<Viewer accountId="a1" folder="INBOX" row={row} folders={FOLDERS} onClose={() => {}} {...props} />);

  it('is the old toolbar by default, with Reply, Reply all and Forward under More', () => {
    view({ folders: [] });
    expect(tools()).toEqual(['seen', 'flag', 'move', 'delete', 'more']);
    fireEvent.click(document.querySelector('[data-mv-tool="more"]'));
    expect(moreActions()).toEqual(['reply', 'replyAll', 'forward']);
    expect(document.querySelector('[data-mv-compose-mode="reply"]')).toBeTruthy();
  });

  it('shows the chosen actions in order and runs them', () => {
    withBar(['reply', 'delete']);
    const onCompose = vi.fn();
    const onDelete = vi.fn();
    view({ onCompose, onDelete });
    expect(tools()).toEqual(['reply', 'delete', 'more']);
    fireEvent.click(document.querySelector('[data-mv-tool="reply"]'));
    expect(onCompose).toHaveBeenCalledWith('reply');
    fireEvent.click(document.querySelector('[data-mv-tool="delete"]'));
    expect(onDelete).toHaveBeenCalled();
    fireEvent.click(document.querySelector('[data-mv-tool="more"]'));
    expect(moreActions()).toEqual(['toggleRead', 'flag', 'move', 'spam', 'replyAll', 'forward']);
  });

  it('runs a toggle from More', () => {
    withBar(['reply']);
    const onAction = vi.fn(async () => ({ ok: true }));
    view({ onAction });
    fireEvent.click(document.querySelector('[data-mv-tool="more"]'));
    fireEvent.click(document.querySelector('[data-mv-more-action="toggleRead"]'));
    expect(onAction).toHaveBeenCalledWith('seen');
  });

  it('moves to the Junk folder, and offers that only where there is one', () => {
    withBar(['spam', 'delete']);
    const onMove = vi.fn();
    view({ onMove });
    expect(tools()[0]).toBe('spam');
    fireEvent.click(document.querySelector('[data-mv-tool="spam"]'));
    expect(onMove).toHaveBeenCalledWith('Junk');
    cleanup();
    view({ folders: [FOLDERS[0]] });
    expect(tools()).toEqual(['delete', 'more']);
    fireEvent.click(document.querySelector('[data-mv-tool="more"]'));
    expect(moreActions()).not.toContain('spam');
    cleanup();
    view({ folder: 'Junk' });
    expect(tools()).toEqual(['delete', 'more']);
  });

  it('with nothing on the bar keeps More, so every action stays in reach', () => {
    withBar([]);
    view({ folders: [] });
    expect(tools()).toEqual(['more']);
  });
});

describe('Settings > Appearance > Quick actions', () => {
  const open = () => {
    render(<Settings onClose={() => {}} page="appearance" />);
    // Desktop's Appearance tab of that name.
    fireEvent.click(screen.getByRole('tab', { name: t('quickActions.title') }));
  };
  const barRows = () => [...document.querySelectorAll('[data-mv-qa-bar] [data-mv-qa-action]')].map((r) => r.getAttribute('data-mv-qa-action'));

  it('is a tab of Appearance, as on desktop; Back goes to the list', () => {
    open();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(t('settings.appearance.appearance'));
    expect(screen.getByRole('tab', { name: t('quickActions.title') }).getAttribute('aria-selected')).toBe('true');
    expect(barRows()).toEqual(['toggleRead', 'flag', 'move', 'delete']);
    fireEvent.click(screen.getByRole('button', { name: t('common.back') }));
    expect(document.querySelector('[data-mv-settings-on]').getAttribute('data-mv-settings-on')).toBe('root');
  });

  it('applies a preset', async () => {
    open();
    const select = document.querySelector('[data-mv-pref="quickActionsPreset"]');
    expect(select.value).toBe('mailvault');
    await act(async () => { fireEvent.change(select, { target: { value: 'outlook' } }); });
    await flush();
    expect(sets()).toEqual([{ quickActionsReader: ['reply', 'replyAll', 'forward', 'delete'] }]);
    expect(barRows()).toEqual(['reply', 'replyAll', 'forward', 'delete']);
    expect(document.querySelector('[data-mv-pref="quickActionsPreset"]').value).toBe('outlook');
  });

  it('removes, reorders and adds, never past four', async () => {
    open();
    const rowOf = (a) => document.querySelector(`[data-mv-qa-action="${a}"]`);
    await act(async () => { fireEvent.click(rowOf('flag').querySelector('[data-mv-qa-up]')); });
    await flush();
    expect(barRows()).toEqual(['flag', 'toggleRead', 'move', 'delete']);
    expect(document.querySelector('[data-mv-pref="quickActionsPreset"]').value).toBe('custom');
    expect(rowOf('reply').querySelector('[data-mv-qa-add]').disabled).toBe(true);
    await act(async () => { fireEvent.click(rowOf('move').querySelector('[data-mv-qa-remove]')); });
    await flush();
    await act(async () => { fireEvent.click(rowOf('reply').querySelector('[data-mv-qa-add]')); });
    await flush();
    expect(barRows()).toEqual(['flag', 'toggleRead', 'delete', 'reply']);
    expect(sets().at(-1)).toEqual({ quickActionsReader: ['flag', 'toggleRead', 'delete', 'reply'] });
  });
});
