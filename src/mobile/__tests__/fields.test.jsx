// @vitest-environment jsdom
// Custom fields on the phone: desktop's property strip in the viewer (each field editable in
// place, nothing when the account has none) and desktop's Fields page under Mail preferences, all
// over `mobile.fields.*` (engine fields.rs).
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent, act, within } from '@testing-library/react';
import { t } from '../i18n.js';

const engine = vi.hoisted(() => ({ calls: [], fields: {}, byKey: {}, refuse: null }));

vi.mock('../transport.js', () => ({
  daemonCall: vi.fn(async (method, params = {}) => {
    engine.calls.push([method, params]);
    if (engine.refuse === method) throw Object.assign(new Error('no'), { code: 'INVALID' });
    const key = (i) => `${i.accountId}|${i.folder}|${i.uid}`;
    switch (method) {
      case 'mobile.fields.list':
        return { fields: engine.fields[params.accountId] || [] };
      case 'mobile.fields.values':
        return { values: params.items.map((i) => engine.byKey[key(i)] || {}) };
      case 'mobile.fields.set': {
        const k = key(params.item);
        const v = { ...(engine.byKey[k] || {}) };
        if (params.value === null) delete v[params.fieldId];
        else v[params.fieldId] = params.value;
        engine.byKey[k] = v;
        return {};
      }
      case 'mobile.fields.save': {
        const list = engine.fields[params.field.scope] || [];
        engine.fields[params.field.scope] = [...list.filter((f) => f.id !== params.field.id), params.field];
        return { field: params.field };
      }
      case 'mobile.fields.delete':
        for (const id of Object.keys(engine.fields)) engine.fields[id] = engine.fields[id].filter((f) => f.id !== params.id);
        return { droppedValues: 0 };
      case 'mobile.fields.reorder':
        return { moved: true };
      case 'mobile.fields.optionUsage':
        return { usage: { hi: 3 } };
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
const { resetFieldsForTests } = await import('../fields.js');

const PRIORITY = { id: 'f1', scope: 'a1', name: 'Priority', kind: 'select', position: 0,
  options: [{ id: 'hi', label: 'High', color: '#ff0000' }, { id: 'lo', label: 'Low', color: '' }] };
const DONE = { id: 'f2', scope: '*', name: 'Done', kind: 'checkbox', position: 0, options: [] };
const row = { uid: 7, subject: 'Hello', fromName: 'Ada', fromAddress: 'ada@example.test', to: [], dateMs: Date.UTC(2026, 10, 3), snippet: '', seen: true, flagged: false };
const flush = () => act(async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0)); });
const calls = (m) => engine.calls.filter(([n]) => n === m).map(([, p]) => p);
const ITEM = { accountId: 'a1', folder: 'INBOX', uid: 7 };

beforeEach(() => {
  engine.calls = [];
  engine.fields = {};
  engine.byKey = {};
  engine.refuse = null;
  resetFieldsForTests();
  useMobileStore.setState({
    prefs: PREF_DEFAULTS, activeAccountId: 'a1', activeFolder: 'INBOX',
    accounts: [{ id: 'a1', email: 'u@example.test' }, { id: 'a2', email: 'v@example.test' }],
  });
});
afterEach(cleanup);

const openViewer = async () => {
  render(<Viewer accountId="a1" folder="INBOX" row={row} onClose={() => {}} folders={[{ path: 'INBOX', name: 'INBOX', depth: 0 }]} />);
  await flush();
};

describe('custom fields on the phone', () => {
  it('the viewer shows no strip and asks for no values when the account has no field', async () => {
    await openViewer();
    expect(calls('mobile.fields.list')).toEqual([{ accountId: 'a1' }]);
    expect(calls('mobile.fields.values')).toEqual([]);
    expect(document.querySelector('.field-strip')).toBeNull();
  });

  it('the viewer shows desktop\'s strip with the message\'s values and edits them in place', async () => {
    engine.fields.a1 = [DONE, PRIORITY];
    engine.byKey['a1|INBOX|7'] = { f1: 'hi' };
    await openViewer();
    expect(calls('mobile.fields.values')).toEqual([{ items: [ITEM] }]);
    const strip = document.querySelector('.field-strip.mv-viewer__fields');
    expect([...strip.querySelectorAll('.field-strip-name')].map((n) => n.textContent)).toEqual(['Done', 'Priority']);
    expect(within(strip).getByRole('combobox', { name: 'Priority' }).value).toBe('hi');

    fireEvent.click(within(strip).getByRole('checkbox', { name: 'Done' }));
    await flush();
    expect(calls('mobile.fields.set')).toEqual([{ item: ITEM, fieldId: 'f2', value: true }]);
    expect(within(strip).getByRole('checkbox', { name: 'Done' }).checked).toBe(true);

    fireEvent.change(within(strip).getByRole('combobox', { name: 'Priority' }), { target: { value: '' } });
    await flush();
    expect(calls('mobile.fields.set').at(-1)).toEqual({ item: ITEM, fieldId: 'f1', value: null });
  });

  it('a refused value goes back', async () => {
    engine.fields.a1 = [DONE];
    await openViewer();
    engine.refuse = 'mobile.fields.set';
    fireEvent.click(screen.getByRole('checkbox', { name: 'Done' }));
    await flush();
    expect(screen.getByRole('checkbox', { name: 'Done' }).checked).toBe(false);
  });

  it('Mail preferences has desktop\'s Fields page for the active account', async () => {
    engine.fields.a1 = [DONE, PRIORITY];
    render(<Settings onClose={() => {}} page="mail-preferences" />);
    fireEvent.click(screen.getByRole('tab', { name: t('fields.section') }));
    await flush();
    expect(screen.getByText(t('mobile.fields.explainer'))).toBeTruthy();
    expect(screen.getByTestId('field-row-f1').textContent).toContain('Priority');
    expect(screen.getByTestId('field-row-f2').textContent).toContain(t('fields.scope.global'));

    fireEvent.change(screen.getByTestId('new-field-name'), { target: { value: 'Client' } });
    fireEvent.change(screen.getByTestId('new-field-kind'), { target: { value: 'text' } });
    fireEvent.submit(screen.getByTestId('new-field-form'));
    await flush();
    const saved = calls('mobile.fields.save')[0].field;
    expect(saved).toMatchObject({ scope: 'a1', name: 'Client', kind: 'text' });
    expect(screen.getByTestId(`field-row-${saved.id}`)).toBeTruthy();

    fireEvent.click(screen.getByTestId('field-delete-f1'));
    fireEvent.click(screen.getByTestId('field-delete-confirm-f1'));
    await flush();
    expect(calls('mobile.fields.delete')).toEqual([{ id: 'f1' }]);
    expect(screen.queryByTestId('field-row-f1')).toBeNull();
  });

  it('a refused change says so under the page', async () => {
    engine.fields.a1 = [PRIORITY];
    render(<Settings onClose={() => {}} page="mail-preferences" />);
    fireEvent.click(screen.getByRole('tab', { name: t('fields.section') }));
    await flush();
    engine.refuse = 'mobile.fields.save';
    fireEvent.click(screen.getByTestId('field-scope-f1'));
    await flush();
    expect(screen.getByRole('alert').textContent).toBe(t('mobile.settings.saveFailed'));
  });

  it('setting search finds the Fields page and lands on it', async () => {
    render(<Settings onClose={() => {}} />);
    fireEvent.change(screen.getByRole('searchbox', { name: t('settings.navigation.searchSetting') }), { target: { value: t('fields.newName') } });
    fireEvent.click(screen.getAllByRole('button').find((b) => b.textContent.includes(t('fields.newName'))));
    await flush();
    expect(screen.getByTestId('new-field-form')).toBeTruthy();
  });
});
