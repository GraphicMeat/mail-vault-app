// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ listener: null, messages: [], destroy: vi.fn(), result: null }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (_name, handler) => { fixture.listener = handler; return () => {}; }),
  emit: vi.fn(async (_name, message) => {
    fixture.messages.push(message);
    const answer = (type, payload) => fixture.listener({ payload: { ...message, type, payload } });
    if (message.type === 'ready') await answer('initialize', { snapshot: {}, settings: {} });
    if (message.type === 'initialized') await answer('activate');
    if (message.type === 'prepare-settings' && !message.payload) await answer('ack', 42);
    if (message.type === 'prepare-settings' && message.payload?.purpose === 'invalidate-send-check') await answer('ack');
    if (message.type === 'send' && fixture.result) await answer('ack', fixture.result);
  }),
}));
vi.mock('@tauri-apps/api/webviewWindow', () => ({ getCurrentWebviewWindow: () => ({ destroy: fixture.destroy, onCloseRequested: async () => () => {} }) }));
vi.mock('../../stores/mailStore', () => ({ useMailStore: { setState: vi.fn() } }));
vi.mock('../../stores/settingsStore', () => ({ useSettingsStore: { getState: () => ({}), setState: vi.fn() } }));
vi.mock('../../stores/themeStore', () => ({ useThemeStore: { getState: () => ({ setTheme() {}, setPalette() {}, initTheme() {} }), setState: vi.fn() } }));
vi.mock('../../utils/privacy/privacySync', () => ({ startPrivacySync: () => () => {} }));
vi.mock('../privacy/PrivacyDictionaryHost', () => ({ PrivacyDictionaryHost: () => null }));
vi.mock('../ComposeModal', () => ({ ComposeModal: props => {
  const [result, setResult] = React.useState('');
  return <><button onClick={() => props.prepareSendCheck({ attempt: 1, editorGeneration: 1, snapshot: {}, authoredBodyText: '', timeZone: 'UTC' }).then(value => setResult(value.kind)).catch(error => setResult(error.message))}>Check</button>
    <button onClick={() => props.acknowledgePreparation().then(value => setResult(String(value)))}>Reply ACK</button>
    <button onClick={() => props.finalizeSendCheck({ attempt: 1, editorGeneration: 1 }, false).then(value => setResult(value?.kind || 'accepted'))}>Admit</button>
    <output>{result}</output></>;
} }));
const { ComposeWindow } = await import('../ComposeWindow');
const boot = async () => { await act(async () => { render(<ComposeWindow />); }); };
beforeEach(() => { vi.useFakeTimers(); fixture.messages = []; fixture.result = null; fixture.destroy.mockClear(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });
it('allows a send check beyond 10 seconds and retires it at the finite 70 second timeout', async () => {
  await boot(); fireEvent.click(screen.getByText('Check'));
  await act(async () => { await vi.advanceTimersByTimeAsync(69_999); });
  expect(screen.getByRole('status').textContent).toBe('');
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(screen.getByRole('status').textContent).toContain('timed out');
  expect(fixture.messages.at(-1).payload).toEqual({ purpose: 'invalidate-send-check', editorGeneration: 2 });
  const check = fixture.messages.find(message => message.payload?.purpose === 'send-check');
  await act(async () => fixture.listener({ payload: { ...check, type: 'ack', payload: { attempt: 1, editorGeneration: 1, outcome: { kind: 'ready', route: { delay: null } } } } }));
  expect(fixture.destroy).not.toHaveBeenCalled();
  expect(fixture.messages.some(message => message.type === 'send')).toBe(false);
});
it('preserves numeric reply ACK and interprets final invalid ACK without closing', async () => {
  await boot(); await act(async () => { fireEvent.click(screen.getByText('Reply ACK')); });
  expect(screen.getByRole('status').textContent).toBe('42');
  fixture.result = { attempt: 1, editorGeneration: 1, outcome: { kind: 'invalid', key: 'scheduled.picker.pastTime' } };
  await act(async () => { fireEvent.click(screen.getByText('Admit')); });
  expect(screen.getByRole('status').textContent).toBe('invalid');
  expect(fixture.destroy).not.toHaveBeenCalled();
});
