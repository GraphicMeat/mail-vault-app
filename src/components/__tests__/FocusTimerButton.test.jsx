// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';

vi.mock('lucide-react', () => {
  const icon = (name) => (props) => React.createElement('span', { 'data-icon': name, ...props });
  return new Proxy({}, {
    get: (_t, name) => (typeof name === 'symbol' || name === 'then' ? undefined : icon(String(name))),
    has: () => true,
  });
});

vi.mock('../../stores/safeStorage', () => {
  const store = {};
  return {
    safeStorage: {
      getItem: (key) => store[key] ?? null,
      setItem: (key, val) => { store[key] = val; },
      removeItem: (key) => { delete store[key]; },
    },
  };
});

vi.mock('../../services/api', () => ({
  sendNotification: vi.fn(() => Promise.resolve()),
}));

// The upsell branch pulls in PremiumFeaturesLink, which opens a real URL.
vi.mock('../../services/billingApi', () => ({
  openInBrowser: vi.fn(() => Promise.resolve()),
}));

const { useFocusStore } = await import('../../stores/focusStore');
const { useSettingsStore } = await import('../../stores/settingsStore');
const { FocusTimerButton } = await import('../FocusTimerButton');

const PREMIUM = { hasSubscription: true, premiumAccess: true, status: 'active' };
const FREE = { hasSubscription: false };

beforeEach(() => {
  useFocusStore.getState().abandon();
  useFocusStore.setState({ endsAt: null, held: [], durationMin: 25, scene: 'countryside' });
  useSettingsStore.setState({ billingProfile: PREMIUM });
});

afterEach(() => {
  useFocusStore.getState().abandon();
  cleanup();
  document.body.innerHTML = '';
});

const custom = () => screen.getByTestId('focus-custom');
const typeMinutes = (value) => fireEvent.change(custom(), { target: { value } });

describe('FocusTimerButton — idle', () => {
  it('offers the session by name', () => {
    render(<FocusTimerButton />);
    expect(screen.getByTestId('focus-button').textContent).toContain('Focus session');
  });

  it('opens the dialog, takes a preset and starts', () => {
    render(<FocusTimerButton />);
    fireEvent.click(screen.getByTestId('focus-button'));
    expect(screen.getByTestId('focus-dialog')).toBeTruthy();

    fireEvent.click(screen.getByTestId('focus-preset-45'));
    expect(screen.getByTestId('focus-preset-45').getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('focus-preset-25').getAttribute('aria-checked')).toBe('false');

    const before = Date.now();
    fireEvent.click(screen.getByTestId('focus-start'));

    const s = useFocusStore.getState();
    expect(s.durationMin).toBe(45);
    expect(s.endsAt).toBeGreaterThanOrEqual(before + 45 * 60_000);
    expect(s.endsAt).toBeLessThanOrEqual(Date.now() + 45 * 60_000);
    expect(document.querySelector('[data-testid="focus-dialog"]')).toBe(null);
  });

  // The tint alone lost to the raised bordered chips beside it: the freshly
  // DEselected preset read as the chosen one. The accent border is the tell.
  it('draws the accent border on the chosen chip only', () => {
    render(<FocusTimerButton />);
    fireEvent.click(screen.getByTestId('focus-button'));
    fireEvent.click(screen.getByTestId('focus-preset-45'));

    expect(screen.getByTestId('focus-preset-45').className).toContain('border-mail-accent');
    expect(screen.getByTestId('focus-preset-25').className).not.toContain('border-mail-accent');
  });

  // Persist hydration lands after mount in the real app, so the dialog has to
  // read the remembered preset when it opens, not when the sidebar mounted.
  it('opens on the remembered preset even when it arrives after mount', () => {
    render(<FocusTimerButton />);
    act(() => useFocusStore.setState({ durationMin: 45 }));

    fireEvent.click(screen.getByTestId('focus-button'));

    expect(screen.getByTestId('focus-preset-45').getAttribute('aria-checked')).toBe('true');
  });
});

describe('FocusTimerButton: custom minutes', () => {
  it('starts a session on a number no preset offers', () => {
    render(<FocusTimerButton />);
    fireEvent.click(screen.getByTestId('focus-button'));

    typeMinutes('30');
    for (const n of [15, 25, 45, 60]) {
      expect(screen.getByTestId(`focus-preset-${n}`).getAttribute('aria-checked')).toBe('false');
    }

    const before = Date.now();
    fireEvent.click(screen.getByTestId('focus-start'));

    const s = useFocusStore.getState();
    expect(s.durationMin).toBe(30);
    expect(s.endsAt).toBeGreaterThanOrEqual(before + 30 * 60_000);
    expect(s.endsAt).toBeLessThanOrEqual(Date.now() + 30 * 60_000);
  });

  // One source of truth: the chips read the same state the field writes.
  it('lights the matching chip when the typed number is a preset', () => {
    render(<FocusTimerButton />);
    fireEvent.click(screen.getByTestId('focus-button'));

    typeMinutes('45');
    expect(screen.getByTestId('focus-preset-45').getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('focus-preset-25').getAttribute('aria-checked')).toBe('false');
  });

  it('shows the custom value again next time, with no chip lit', () => {
    render(<FocusTimerButton />);
    fireEvent.click(screen.getByTestId('focus-button'));
    typeMinutes('30');
    fireEvent.click(screen.getByTestId('focus-start'));

    fireEvent.click(screen.getByTestId('focus-button'));
    expect(custom().value).toBe('30');
    for (const n of [15, 25, 45, 60]) {
      expect(screen.getByTestId(`focus-preset-${n}`).getAttribute('aria-checked')).toBe('false');
    }
  });

  // A blank field is a user midway through retyping, not a zero-minute session.
  it('refuses to start on 0, on 481 and on an empty field', () => {
    render(<FocusTimerButton />);
    fireEvent.click(screen.getByTestId('focus-button'));

    for (const bad of ['0', '481', '']) {
      typeMinutes(bad);
      expect(screen.getByTestId('focus-start').disabled).toBe(true);
    }

    typeMinutes('480');
    expect(screen.getByTestId('focus-start').disabled).toBe(false);
  });
});

describe('FocusTimerButton: premium gate', () => {
  for (const [label, profile] of [['no profile', null], ['no subscription', FREE]]) {
    it(`sells the feature instead of starting one with ${label}`, () => {
      useSettingsStore.setState({ billingProfile: profile });
      render(<FocusTimerButton />);
      fireEvent.click(screen.getByTestId('focus-button'));

      expect(screen.getByTestId('focus-upsell')).toBeTruthy();
      expect(document.querySelector('[data-testid="focus-start"]')).toBe(null);
      expect(document.querySelector('[data-testid="focus-preset-25"]')).toBe(null);
      expect(document.querySelector('[data-testid="focus-custom"]')).toBe(null);
    });
  }

  it('hands Upgrade to the caller and gets out of the way', () => {
    const onUpgrade = vi.fn();
    useSettingsStore.setState({ billingProfile: FREE });
    render(<FocusTimerButton onUpgrade={onUpgrade} />);
    fireEvent.click(screen.getByTestId('focus-button'));

    fireEvent.click(screen.getByText('Upgrade'));

    expect(onUpgrade).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-testid="focus-dialog"]')).toBe(null);
  });

  it('shows the presets to a subscriber', () => {
    useSettingsStore.setState({ billingProfile: PREMIUM });
    render(<FocusTimerButton />);
    fireEvent.click(screen.getByTestId('focus-button'));

    expect(screen.getByTestId('focus-preset-25')).toBeTruthy();
    expect(screen.getByTestId('focus-start')).toBeTruthy();
    expect(document.querySelector('[data-testid="focus-upsell"]')).toBe(null);
  });
});

describe('FocusTimerButton — scene', () => {
  const open = () => {
    render(<FocusTimerButton />);
    fireEvent.click(screen.getByTestId('focus-button'));
  };
  const checked = id => screen.getByTestId(`focus-scene-${id}`).getAttribute('aria-checked');

  it('offers the three scenes and the plain lock, on the remembered one', () => {
    useFocusStore.setState({ scene: 'town' });
    open();
    expect(['countryside', 'sea', 'town', 'none'].map(checked)).toEqual(['false', 'false', 'true', 'false']);
    expect(screen.getByRole('radiogroup', { name: 'Scene' })).toBeTruthy();
  });

  it('starts the session on the scene picked', () => {
    open();
    fireEvent.click(screen.getByTestId('focus-scene-sea'));
    expect(checked('sea')).toBe('true');
    expect(checked('countryside')).toBe('false');
    fireEvent.click(screen.getByTestId('focus-start'));
    expect(useFocusStore.getState().scene).toBe('sea');
    expect(useFocusStore.getState().endsAt).not.toBe(null);
  });

  it('moves the choice with the arrow keys, since there is no field to type a scene into', () => {
    open();
    const group = screen.getByRole('radiogroup', { name: 'Scene' });
    fireEvent.keyDown(group, { key: 'ArrowRight' });
    expect(checked('sea')).toBe('true');
    expect(document.activeElement).toBe(screen.getByTestId('focus-scene-sea'));
    fireEvent.keyDown(group, { key: 'ArrowLeft' });
    fireEvent.keyDown(group, { key: 'ArrowLeft' });
    expect(checked('none')).toBe('true');
    expect(screen.getByTestId('focus-scene-none').getAttribute('tabindex')).toBe('0');
    expect(screen.getByTestId('focus-scene-countryside').getAttribute('tabindex')).toBe('-1');
  });

  it('only remembers a scene once a session starts on it', () => {
    open();
    fireEvent.click(screen.getByTestId('focus-scene-none'));
    expect(checked('none')).toBe('true');
    expect(useFocusStore.getState().scene).toBe('countryside');
  });
});
