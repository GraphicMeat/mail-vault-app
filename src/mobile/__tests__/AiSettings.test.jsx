// @vitest-environment jsdom
// Settings > AI and the features it drives on the phone: the endpoint, its key (the engine's
// secret store, never shown again), the review before a send (and skipping it), and quick replies
// in the viewer. The engine (`ai.rs`) decides what may be sent; these pin what the page does with
// its answers.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { t } from '../i18n.js';

const engine = vi.hoisted(() => ({ calls: [], prefs: {}, hasKey: false, run: null, prompt: null, quick: null, quickGen: null }));

vi.mock('../transport.js', () => ({
  daemonCall: vi.fn(async (method, params = {}) => {
    engine.calls.push([method, params]);
    switch (method) {
      case 'mobile.prefs.set':
        engine.prefs = { ...engine.prefs, ...params };
        return { ...engine.prefs };
      case 'mobile.ai.status':
        return { hasKey: engine.hasKey, reviewed: false };
      case 'mobile.ai.setKey':
        engine.hasKey = Boolean(params.key);
        return { hasKey: engine.hasKey };
      case 'mobile.ai.prompt':
        return engine.prompt;
      case 'mobile.ai.run':
        return typeof engine.run === 'function' ? engine.run(params) : engine.run;
      case 'mobile.ai.quickReplies':
        return params.generate ? engine.quickGen : engine.quick;
      case 'mobile.ai.dismissQuickReplies':
        return {};
      default:
        throw Object.assign(new Error(method), { code: 'UNSUPPORTED' });
    }
  }),
  listen: vi.fn(() => () => {}),
}));

const { default: AiSettings } = await import('../AiSettings.jsx');
const { default: QuickReplies } = await import('../QuickReplies.jsx');
const { useMobileStore } = await import('../store.js');
const { PREF_DEFAULTS, readPrefs } = await import('../prefs.js');

const called = (m) => engine.calls.filter(([name]) => name === m).map(([, p]) => p);
const flush = () => act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); });
// The page's prefs and the engine's, alike.
const setPrefs = (p) => {
  engine.prefs = { ...PREF_DEFAULTS, ...p };
  useMobileStore.setState({ prefs: { ...PREF_DEFAULTS, ...p } });
};

beforeEach(() => {
  engine.calls = [];
  engine.hasKey = false;
  engine.run = null;
  engine.prompt = null;
  engine.quick = null;
  engine.quickGen = null;
  setPrefs({});
});
afterEach(cleanup);

describe('AI preferences', () => {
  it('default off with no endpoint, and only well-typed values are read', () => {
    expect(PREF_DEFAULTS).toMatchObject({ aiEnabled: false, aiEndpointUrl: '', aiEndpointModel: '', aiSkipPreview: false });
    expect(readPrefs({ aiEnabled: 'yes', aiEndpointUrl: 3 })).toMatchObject({ aiEnabled: false, aiEndpointUrl: '' });
    expect(readPrefs({ aiEnabled: true, aiEndpointUrl: 'https://ai.example.test/v1' })).toMatchObject({ aiEnabled: true, aiEndpointUrl: 'https://ai.example.test/v1' });
  });
});

describe('Settings > AI', () => {
  it('shows only the switch while off; turning it on writes aiEnabled', async () => {
    render(<AiSettings />);
    await flush();
    expect([...document.querySelectorAll('[data-mv-pref]')].map((e) => e.getAttribute('data-mv-pref'))).toEqual(['aiEnabled']);
    await act(async () => { fireEvent.click(screen.getByRole('switch', { name: t('ai.settings.enable') })); });
    await flush();
    expect(called('mobile.prefs.set')).toEqual([{ aiEnabled: true }]);
    expect([...document.querySelectorAll('[data-mv-pref]')].map((e) => e.getAttribute('data-mv-pref')))
      .toEqual(['aiEnabled', 'aiEndpointUrl', 'aiEndpointModel', 'aiSkipPreview']);
    expect(document.querySelector('[data-mv-ai-google]').textContent).toBe(t('mobile.ai.googleNote'));
  });

  it('saves the URL and model when the field is left, trimmed', async () => {
    setPrefs({ aiEnabled: true });
    render(<AiSettings />);
    await flush();
    const url = document.querySelector('[data-mv-pref="aiEndpointUrl"]');
    fireEvent.change(url, { target: { value: ' https://ai.example.test/v1 ' } });
    await act(async () => { fireEvent.blur(url); });
    const model = document.querySelector('[data-mv-pref="aiEndpointModel"]');
    fireEvent.change(model, { target: { value: 'llama3' } });
    await act(async () => { fireEvent.blur(model); });
    await flush();
    expect(called('mobile.prefs.set')).toEqual([{ aiEndpointUrl: 'https://ai.example.test/v1' }, { aiEndpointModel: 'llama3' }]);
  });

  it('hands the key to the engine, clears the field and never shows it again', async () => {
    setPrefs({ aiEnabled: true });
    render(<AiSettings />);
    await flush();
    const field = document.querySelector('[data-mv-ai-key]');
    expect(field.getAttribute('type')).toBe('password');
    fireEvent.change(field, { target: { value: 'sk-secret' } });
    await act(async () => { fireEvent.click(document.querySelector('[data-mv-ai-key-save]')); });
    await flush();
    expect(called('mobile.ai.setKey')).toEqual([{ key: 'sk-secret' }]);
    expect(field.value).toBe('');
    expect(document.body.textContent).not.toContain('sk-secret');
    expect(screen.getByText(t('ai.settings.keySaved'))).toBeTruthy();
    expect(called('mobile.prefs.set')).toEqual([], 'the key is never a preference');
    await act(async () => { fireEvent.click(document.querySelector('[data-mv-ai-key-remove]')); });
    await flush();
    expect(called('mobile.ai.setKey')[1]).toEqual({ key: '' });
    expect(document.querySelector('[data-mv-ai-key-remove]')).toBeNull();
  });

  it('the test is reviewed first: the exact text and where it goes, then sent confirmed', async () => {
    setPrefs({ aiEnabled: true, aiEndpointUrl: 'https://ai.example.test/v1' });
    engine.prompt = { ok: true, prompt: 'Reply with exactly one short sentence.', destination: 'https://ai.example.test/v1', leavesDevice: true };
    engine.run = { ok: true, text: 'Received.' };
    render(<AiSettings />);
    await flush();
    await act(async () => { fireEvent.click(document.querySelector('[data-mv-ai-test]')); });
    await flush();
    expect(called('mobile.ai.run')).toEqual([], 'nothing is sent before the review');
    expect(document.querySelector('[data-mv-ai-prompt]').textContent).toBe('Reply with exactly one short sentence.');
    expect(document.querySelector('[data-mv-ai-destination]').textContent).toBe(t('ai.preview.destination', { destination: 'https://ai.example.test/v1' }));
    expect(screen.getByText(t('ai.preview.leavesDevice'))).toBeTruthy();
    await act(async () => { fireEvent.click(document.querySelector('[data-mv-ai-send]')); });
    await flush();
    expect(called('mobile.ai.run')).toEqual([{ action: 'test', confirmed: true }]);
    expect(document.querySelector('[data-mv-ai-prompt]')).toBeNull();
    expect(document.querySelector('[data-mv-ai-test-result]').textContent).toBe('Received.');
  });

  it('skipping the review asks the engine directly, and falls back to the review when it wants one', async () => {
    setPrefs({ aiEnabled: true, aiEndpointUrl: 'https://ai.example.test/v1', aiSkipPreview: true });
    engine.run = (p) => (p.confirmed ? { ok: true, text: 'ok' } : { ok: false, code: 'REVIEW_REQUIRED' });
    engine.prompt = { ok: true, prompt: 'P', destination: 'https://ai.example.test/v1', leavesDevice: true };
    render(<AiSettings />);
    await flush();
    await act(async () => { fireEvent.click(document.querySelector('[data-mv-ai-test]')); });
    await flush();
    expect(called('mobile.ai.run')).toEqual([{ action: 'test' }]);
    expect(document.querySelector('[data-mv-ai-prompt]').textContent).toBe('P');
    engine.calls = [];
    engine.run = { ok: true, text: 'direct' };
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: t('common.cancel') })); });
    await act(async () => { fireEvent.click(document.querySelector('[data-mv-ai-test]')); });
    await flush();
    expect(called('mobile.ai.prompt')).toEqual([], 'a reviewed endpoint runs without the sheet');
    expect(document.querySelector('[data-mv-ai-test-result]').textContent).toBe('direct');
  });

  it('a refusal reads as its catalog text', async () => {
    setPrefs({ aiEnabled: true, aiEndpointUrl: 'https://ai.example.test/v1' });
    engine.prompt = { ok: false, code: 'AI_NOT_CONFIGURED' };
    render(<AiSettings />);
    await flush();
    await act(async () => { fireEvent.click(document.querySelector('[data-mv-ai-test]')); });
    await flush();
    expect(screen.getByRole('alert').textContent).toBe(t('mobile.ai.notConfigured'));
  });
});

describe('quick replies', () => {
  const props = { accountId: 'a1', folder: 'INBOX', uid: 7 };

  it('show the deterministic starters of the shape, and a tap opens a reply with one', async () => {
    engine.quick = { show: true, shape: 'question', starters: null };
    const onReply = vi.fn();
    render(<QuickReplies {...props} onReply={onReply} />);
    await flush();
    const chips = [...document.querySelectorAll('[data-mv-quick-reply]')].map((c) => c.textContent);
    expect(chips).toEqual([t('ai.quickReply.question.yes'), t('ai.quickReply.question.no'), t('ai.quickReply.question.checkBack')]);
    expect(called('mobile.ai.quickReplies')).toEqual([{ ...props, generate: false }], 'AI off: nothing is generated');
    fireEvent.click(document.querySelectorAll('[data-mv-quick-reply]')[1]);
    expect(onReply).toHaveBeenCalledWith(t('ai.quickReply.question.no'));
  });

  it('with AI on, generated starters replace them when the engine has some', async () => {
    setPrefs({ aiEnabled: true });
    engine.quick = { show: true, shape: 'request', starters: null };
    engine.quickGen = { show: true, shape: 'request', starters: ['Sure thing', 'On it'] };
    render(<QuickReplies {...props} onReply={() => {}} />);
    await flush();
    expect([...document.querySelectorAll('[data-mv-quick-reply]')].map((c) => c.textContent)).toEqual(['Sure thing', 'On it']);
    expect(called('mobile.ai.quickReplies').map((p) => p.generate)).toEqual([false, true]);
  });

  it('show nothing when the engine says so, and dismiss for good', async () => {
    engine.quick = { show: false, shape: 'request', starters: null };
    const r = render(<QuickReplies {...props} onReply={() => {}} />);
    await flush();
    expect(document.querySelector('[data-mv-quick-replies]')).toBeNull();
    r.unmount();
    engine.quick = { show: true, shape: 'request', starters: null };
    render(<QuickReplies {...props} onReply={() => {}} />);
    await flush();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: t('ai.quickReply.dismiss') })); });
    expect(document.querySelector('[data-mv-quick-replies]')).toBeNull();
    expect(called('mobile.ai.dismissQuickReplies')).toEqual([props]);
  });
});
