// @vitest-environment jsdom
// Settings > Mail preferences: the attachment reminder switch and the templates list (add, edit,
// delete), each written to the engine's preferences (`attachmentReminder`, `templates`).
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
      default:
        throw Object.assign(new Error(method), { code: 'UNSUPPORTED' });
    }
  }),
  listen: vi.fn(() => () => {}),
}));

const { default: SettingsPrefs } = await import('../SettingsPrefs.jsx');
const { useMobileStore } = await import('../store.js');
const { PREF_DEFAULTS, readPrefs } = await import('../prefs.js');

const sets = () => engine.calls.filter(([m]) => m === 'mobile.prefs.set').map(([, p]) => p);
const flush = () => act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); });

beforeEach(() => {
  engine.calls = [];
  engine.prefs = { ...PREF_DEFAULTS };
  useMobileStore.setState({ prefs: PREF_DEFAULTS });
});
afterEach(cleanup);

describe('prefs', () => {
  it('reads the reminder and the templates, and nothing but a list as templates', () => {
    expect(PREF_DEFAULTS.attachmentReminder).toBe(true);
    expect(PREF_DEFAULTS.templates).toEqual([]);
    expect(readPrefs({ templates: null }).templates).toEqual([]);
    expect(readPrefs({ templates: { a: 1 } }).templates).toEqual([]);
    expect(readPrefs({ templates: [{ name: 'A', body: 'b' }], attachmentReminder: false })).toMatchObject({
      templates: [{ name: 'A', body: 'b' }], attachmentReminder: false,
    });
  });
});

describe('attachment reminder', () => {
  it('turns off and on', async () => {
    render(<SettingsPrefs section="mail" />);
    const sw = screen.getByRole('switch', { name: t('settings.behavior.attachmentReminder') });
    expect(sw.getAttribute('aria-checked')).toBe('true');
    await act(async () => { fireEvent.click(sw); });
    await flush();
    expect(sets()).toEqual([{ attachmentReminder: false }]);
    expect(screen.getByRole('switch', { name: t('settings.behavior.attachmentReminder') }).getAttribute('aria-checked')).toBe('false');
  });
});

describe('templates', () => {
  it('adds one with a name and a body', async () => {
    render(<SettingsPrefs section="mail" />);
    expect(screen.getByText(t('settings.templates.noTemplatesYetCreateOne'))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t('settings.templates.addTemplate') }));
    fireEvent.change(screen.getByLabelText(t('settings.templates.templateName')), { target: { value: 'Thanks' } });
    fireEvent.change(screen.getByLabelText(t('settings.templates.templateBody')), { target: { value: 'Thank you!' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: t('common.save') })); });
    await flush();
    expect(sets()).toEqual([{ templates: [{ name: 'Thanks', body: 'Thank you!' }] }]);
    expect(screen.getByText('Thanks')).toBeTruthy();
  });

  it('will not save one without a name or a body', async () => {
    render(<SettingsPrefs section="mail" />);
    fireEvent.click(screen.getByRole('button', { name: t('settings.templates.addTemplate') }));
    fireEvent.change(screen.getByLabelText(t('settings.templates.templateName')), { target: { value: 'Only a name' } });
    expect(screen.getByRole('button', { name: t('common.save') }).disabled).toBe(true);
  });

  it('edits and deletes, keeping what the import gave each one', async () => {
    const list = [{ id: 'x', name: 'Thanks', body: 'Thank you!' }, { name: 'Later', body: 'Talk later.' }];
    engine.prefs.templates = list;
    useMobileStore.setState({ prefs: { ...PREF_DEFAULTS, templates: list } });
    render(<SettingsPrefs section="mail" />);
    fireEvent.click(screen.getByRole('button', { name: `${t('settings.templates.editTemplate')}: Thanks` }));
    fireEvent.change(screen.getByLabelText(t('settings.templates.templateBody')), { target: { value: 'Many thanks!' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: t('common.save') })); });
    await flush();
    expect(sets().at(-1)).toEqual({ templates: [{ id: 'x', name: 'Thanks', body: 'Many thanks!' }, { name: 'Later', body: 'Talk later.' }] });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: `${t('settings.templates.deleteTemplate')}: Later` })); });
    await flush();
    expect(sets().at(-1)).toEqual({ templates: [{ id: 'x', name: 'Thanks', body: 'Many thanks!' }] });
  });
});
