// @vitest-environment jsdom
// The phone's first-run tour (src/mobile/onboarding/): language first, then an account (import from
// the computer or add one by hand), what is free, what Premium adds, done. Back and Skip tour as on
// the desktop; a replay with accounts drops the account step.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import en from '../../i18n/locales/en.json';
import de from '../../i18n/locales/de.json';

const engine = vi.hoisted(() => ({ calls: [], settings: {} }));

vi.mock('../transport.js', () => ({
  daemonCall: vi.fn(async (method, params = {}) => {
    engine.calls.push([method, params]);
    switch (method) {
      case 'mobile.settings.get':
        return { ...engine.settings };
      case 'mobile.settings.set':
        engine.settings = { ...engine.settings, ...params };
        return { ...engine.settings };
      default:
        throw Object.assign(new Error(method), { code: 'UNSUPPORTED' });
    }
  }),
  listen: vi.fn(() => () => {}),
}));

// The import flow has its own tests (ImportFromDesktop.test.jsx): here it only has to open and
// hand back its result.
vi.mock('../ImportFromDesktop.jsx', () => ({
  default: ({ onDone, onCancel }) => (
    <div data-testid="import-stub">
      <button type="button" onClick={() => onDone({ imported: ['ada@example.test'] })}>stub-done</button>
      <button type="button" onClick={() => onDone({ imported: [] })}>stub-done-empty</button>
      <button type="button" onClick={onCancel}>stub-cancel</button>
    </div>
  ),
}));

const { mobileOnboardingSteps, onboardingGate } = await import('../onboarding/steps.js');
const { default: Onboarding } = await import('../onboarding/Onboarding.jsx');
const { useMobileStore } = await import('../store.js');
const { loadMobileLocale, getMobileLocale, t } = await import('../i18n.js');

const progress = (current, total) => en['onboarding.progress'].replace('{{current}}', current).replace('{{total}}', total);
const sets = () => engine.calls.filter(([m]) => m === 'mobile.settings.set').map(([, p]) => p);
const cont = () => fireEvent.click(screen.getByTestId('onboarding-continue'));

beforeEach(() => {
  engine.calls = [];
  engine.settings = {};
});

afterEach(async () => {
  cleanup();
  await loadMobileLocale(['en']);
});

describe('mobileOnboardingSteps', () => {
  it('runs language, account, free, premium, done on a fresh phone', () => {
    expect(mobileOnboardingSteps(0)).toEqual(['language', 'account', 'free', 'premium', 'done']);
  });

  it('drops the account step when there are accounts (a replay)', () => {
    expect(mobileOnboardingSteps(1)).toEqual(['language', 'free', 'premium', 'done']);
    expect(mobileOnboardingSteps(3)).toEqual(['language', 'free', 'premium', 'done']);
  });
});

describe('onboardingGate', () => {
  it('shows the tour on a fresh install: not completed and no accounts', () => {
    expect(onboardingGate({ onboardingComplete: false }, 0)).toBe('show');
    expect(onboardingGate({}, 0)).toBe('show');
  });

  it('marks an existing install with accounts complete without showing it', () => {
    expect(onboardingGate({ onboardingComplete: false }, 2)).toBe('markComplete');
    expect(onboardingGate({}, 1)).toBe('markComplete');
  });

  it('never shows it again once completed, and not when the settings could not be read', () => {
    expect(onboardingGate({ onboardingComplete: true }, 0)).toBe('none');
    expect(onboardingGate({ onboardingComplete: true }, 3)).toBe('none');
    expect(onboardingGate(null, 0)).toBe('none');
  });
});

function renderTour(props = {}) {
  const onFinish = vi.fn();
  const utils = render(
    <Onboarding
      steps={mobileOnboardingSteps(0)}
      onAdd={vi.fn(async () => ({ ok: true }))}
      onOAuth={vi.fn(async () => ({ ok: true }))}
      onOAuthCancel={vi.fn()}
      onFinish={onFinish}
      {...props}
    />,
  );
  return { ...utils, onFinish };
}

describe('Onboarding', () => {
  it('starts on the language step with the nine languages, no Back, and Step 1 of 5', () => {
    renderTour();
    expect(screen.getByTestId('onboarding-language')).toBeTruthy();
    expect(screen.getByText(progress(1, 5))).toBeTruthy();
    expect(screen.queryByTestId('onboarding-back')).toBeNull();
    const group = screen.getByRole('radiogroup');
    expect(group.querySelectorAll('[role="radio"]')).toHaveLength(9);
    expect(screen.getByRole('radio', { name: /English/ }).getAttribute('aria-checked')).toBe('true');
  });

  it('a picked language is stored in the engine and the tour switches to it at once', async () => {
    renderTour();
    await act(async () => { fireEvent.click(screen.getByRole('radio', { name: /Deutsch/ })); });
    await waitFor(() => expect(getMobileLocale()).toBe('de'));
    expect(sets()).toContainEqual({ language: 'de' });
    await waitFor(() => expect(screen.getByText(de['mobile.onboarding.languageTitle'])).toBeTruthy());
    expect(screen.getByRole('radio', { name: /Deutsch/ }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('onboarding-continue').textContent).toContain(de['common.continue']);
  });

  it('Continue and Back move one step, and the step count follows', () => {
    renderTour();
    cont();
    expect(screen.getByTestId('onboarding-account')).toBeTruthy();
    expect(screen.getByText(progress(2, 5))).toBeTruthy();
    fireEvent.click(screen.getByTestId('onboarding-back'));
    expect(screen.getByTestId('onboarding-language')).toBeTruthy();
    expect(screen.getByText(progress(1, 5))).toBeTruthy();
  });

  it('system Back goes to the previous step, and closes a running account flow first', async () => {
    const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    const systemBack = async () => {
      await act(async () => { window.dispatchEvent(new PopStateEvent('popstate')); });
      await settle();
    };
    renderTour();
    await settle();
    cont();
    await settle();
    fireEvent.click(screen.getByText(en['onboarding.skipAccount']));
    await settle();
    expect(screen.getByTestId('onboarding-free')).toBeTruthy();
    await systemBack();
    expect(screen.getByText(progress(2, 5))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: en['mobile.import.entry'] }));
    await settle();
    expect(screen.getByTestId('import-stub')).toBeTruthy();
    await systemBack();
    expect(screen.queryByTestId('import-stub')).toBeNull();
    expect(screen.getByRole('button', { name: en['mobile.import.entry'] })).toBeTruthy();
    await systemBack();
    expect(screen.getByTestId('onboarding-language')).toBeTruthy();
    expect(screen.getByText(progress(1, 5))).toBeTruthy();
  });

  it('Skip tour marks the tour complete and leaves it', async () => {
    const { onFinish } = renderTour();
    cont();
    await act(async () => { fireEvent.click(screen.getByTestId('onboarding-skip')); });
    expect(sets()).toContainEqual({ onboardingComplete: true });
    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it('the account step offers Import from computer first, which opens the import flow', () => {
    renderTour();
    cont();
    const buttons = screen.getAllByRole('button').map((b) => b.textContent);
    const importAt = buttons.indexOf(en['mobile.import.entry']);
    const manualAt = buttons.indexOf(en['mobile.onboarding.addManually']);
    expect(importAt).toBeGreaterThan(-1);
    expect(manualAt).toBeGreaterThan(importAt);
    fireEvent.click(screen.getByRole('button', { name: en['mobile.import.entry'] }));
    expect(screen.getByTestId('import-stub')).toBeTruthy();
    // Its Back comes back to the account step.
    fireEvent.click(screen.getByText('stub-cancel'));
    expect(screen.getByRole('button', { name: en['mobile.import.entry'] })).toBeTruthy();
  });

  it('a finished import opens the first imported account and carries on with the tour', async () => {
    const openImported = vi.fn(async () => {});
    useMobileStore.setState({ openImported });
    renderTour();
    cont();
    fireEvent.click(screen.getByRole('button', { name: en['mobile.import.entry'] }));
    await act(async () => { fireEvent.click(screen.getByText('stub-done')); });
    expect(openImported).toHaveBeenCalledWith(['ada@example.test']);
    await waitFor(() => expect(screen.getByTestId('onboarding-free')).toBeTruthy());
  });

  it('an import that added nothing stays on the account step', async () => {
    const openImported = vi.fn(async () => {});
    useMobileStore.setState({ openImported });
    renderTour();
    cont();
    fireEvent.click(screen.getByRole('button', { name: en['mobile.import.entry'] }));
    await act(async () => { fireEvent.click(screen.getByText('stub-done-empty')); });
    expect(openImported).not.toHaveBeenCalled();
    expect(screen.getByTestId('onboarding-account')).toBeTruthy();
    expect(screen.getByRole('button', { name: en['mobile.import.entry'] })).toBeTruthy();
  });

  it('Add account manually opens the provider picker; a sign-in that worked carries on', async () => {
    const onOAuth = vi.fn(async () => ({ ok: true }));
    renderTour({ onOAuth });
    cont();
    fireEvent.click(screen.getByRole('button', { name: en['mobile.onboarding.addManually'] }));
    expect(screen.getByText(en['mobile.add.title'])).toBeTruthy();
    // The picker here is the manual one: the import is the step's own first choice.
    expect(screen.queryByRole('button', { name: en['mobile.import.entry'] })).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['mobile.add.google'] })); });
    expect(onOAuth).toHaveBeenCalledWith('google');
    await waitFor(() => expect(screen.getByTestId('onboarding-free')).toBeTruthy());
  });

  it('Cancel in the manual picker comes back to the account step', () => {
    renderTour();
    cont();
    fireEvent.click(screen.getByRole('button', { name: en['mobile.onboarding.addManually'] }));
    fireEvent.click(screen.getByRole('button', { name: en['common.cancel'] }));
    expect(screen.getByRole('button', { name: en['mobile.import.entry'] })).toBeTruthy();
  });

  it('the account step can be left for later', () => {
    renderTour();
    cont();
    fireEvent.click(screen.getByRole('button', { name: en['onboarding.skipAccount'] }));
    expect(screen.getByTestId('onboarding-free')).toBeTruthy();
  });

  it('free and premium steps list the phone features, then done finishes the tour', async () => {
    const { onFinish } = renderTour();
    cont(); // language -> account
    fireEvent.click(screen.getByRole('button', { name: en['onboarding.skipAccount'] }));
    expect(screen.getByText(en['mobile.onboarding.free.accounts.title'])).toBeTruthy();
    expect(screen.getByText(progress(3, 5))).toBeTruthy();
    cont();
    expect(screen.getByTestId('onboarding-premium')).toBeTruthy();
    expect(screen.getByText(en['mobile.premium.feature.scheduledSend.title'])).toBeTruthy();
    cont();
    expect(screen.getByTestId('onboarding-done')).toBeTruthy();
    // The last step has nothing to skip.
    expect(screen.queryByTestId('onboarding-skip')).toBeNull();
    await act(async () => { cont(); });
    expect(sets()).toContainEqual({ onboardingComplete: true });
    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it('a replay (accounts already there) runs four steps without the account step', () => {
    renderTour({ steps: mobileOnboardingSteps(2) });
    expect(screen.getByText(progress(1, 4))).toBeTruthy();
    cont();
    expect(screen.getByTestId('onboarding-free')).toBeTruthy();
  });

  it('every new string is in the catalog (no raw keys on screen)', () => {
    renderTour();
    expect(document.body.textContent).not.toMatch(/mobile\.onboarding\./);
    expect(t('mobile.onboarding.languageTitle')).toBe(en['mobile.onboarding.languageTitle']);
  });
});
