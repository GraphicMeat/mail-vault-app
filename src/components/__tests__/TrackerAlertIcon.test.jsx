// @vitest-environment jsdom
//
// The glyph has to say one of two things and never the wrong one:
//   "this email tracks you"  — the beacon fired
//   "tracking blocked"       — it was stripped before render
//
// Which one it says is decided by live settings, not by the row's data, so
// these cases drive the real settings store rather than a stubbed flag.

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

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
      getItem: (key) => store[key] || null,
      setItem: (key, val) => { store[key] = val; },
      removeItem: (key) => { delete store[key]; },
    },
  };
});

vi.mock('../../hooks/usePremiumPricing.js', () => ({
  usePremiumPriceBlurb: () => '$4/month or $25/year',
}));

const requestSettingsTab = vi.fn();
vi.mock('../../stores/mailStore', () => ({
  useMailStore: { getState: () => ({ requestSettingsTab }) },
}));

const { useSettingsStore } = await import('../../stores/settingsStore');
const { TrackerAlertIcon, getThreadTrackerInfo } = await import('../TrackerAlertIcon');

const PREMIUM = { hasSubscription: true, status: 'active', premiumAccess: true };
const FREE = { hasSubscription: false };

const ONE = { count: 1, vendors: ['MailChimp'] };
const TRACKERS = [{
  vendor: 'MailChimp',
  domain: 'x.list-manage.com',
  url: 'https://x.list-manage.com/track/open.php?u=8f2',
  reason: 'MailChimp open-tracking beacon',
}];

beforeEach(() => {
  requestSettingsTab.mockClear();
  useSettingsStore.setState({ billingProfile: FREE, shareGrant: null });
});
afterEach(() => cleanup());

describe('TrackerAlertIcon', () => {
  it('renders nothing when the message carries no tracker', () => {
    const { container } = render(<TrackerAlertIcon info={null} blocked={false} />);
    expect(container.innerHTML).toBe('');
    // A summary that somehow arrived with a zero count is the same non-event.
    cleanup();
    const empty = render(<TrackerAlertIcon info={{ count: 0, vendors: [] }} blocked={false} />);
    expect(empty.container.innerHTML).toBe('');
  });

  it('says the email tracks you, with an open eye, when blocking is off', () => {
    render(<TrackerAlertIcon info={ONE} blocked={false} />);
    const button = screen.getByRole('button');
    expect(button.getAttribute('title')).toBe('This email tracks you (1)');
    expect(button.getAttribute('data-blocked')).toBe('false');
    expect(button.querySelector('[data-icon="Eye"]')).toBeTruthy();
  });

  it('says tracking was blocked, with a different glyph, when blocking is on', () => {
    render(<TrackerAlertIcon info={{ count: 2, vendors: ['MailChimp', 'SendGrid'] }} blocked />);
    const button = screen.getByRole('button');
    expect(button.getAttribute('title')).toBe('Tracking blocked (2)');
    expect(button.getAttribute('data-blocked')).toBe('true');
    expect(button.querySelector('[data-icon="EyeOff"]')).toBeTruthy();
    expect(button.querySelector('[data-icon="Eye"]')).toBeNull();
  });

  it('names the tracker and its URL in the dialog', () => {
    render(<TrackerAlertIcon info={ONE} trackers={TRACKERS} blocked={false} />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getAllByText('MailChimp').length).toBeGreaterThan(0);
    expect(screen.getByText(TRACKERS[0].url)).toBeTruthy();
    expect(screen.getByText('MailChimp open-tracking beacon')).toBeTruthy();
  });

  it('falls back to the persisted vendor names when the body was not scanned this session', () => {
    render(<TrackerAlertIcon info={ONE} blocked={false} />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getAllByText('MailChimp').length).toBeGreaterThan(0);
  });

  it('offers the upsell to a free user, with the price', () => {
    render(<TrackerAlertIcon info={ONE} blocked={false} />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('Tracker Blocking is a Premium feature')).toBeTruthy();
    expect(screen.getByText('$4/month or $25/year')).toBeTruthy();
    expect(screen.getByText('See how blocking works')).toBeTruthy();
  });

  it('tells a subscriber the switch is off rather than selling them the feature', () => {
    useSettingsStore.setState({ billingProfile: PREMIUM });
    render(<TrackerAlertIcon info={ONE} blocked={false} />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('Blocking is switched off')).toBeTruthy();
    expect(screen.queryByText('Tracker Blocking is a Premium feature')).toBeNull();
    expect(screen.getByText('Turn on blocking')).toBeTruthy();
  });

  it('drops the upsell entirely once the beacon is actually being blocked', () => {
    useSettingsStore.setState({ billingProfile: PREMIUM });
    render(<TrackerAlertIcon info={ONE} blocked />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.queryByText('Turn on blocking')).toBeNull();
    expect(screen.queryByText('See how blocking works')).toBeNull();
    expect(screen.getByText(/removed a tracking pixel/i)).toBeTruthy();
  });

  it('opens the feature page from the upsell button', () => {
    render(<TrackerAlertIcon info={ONE} blocked={false} />);
    fireEvent.click(screen.getByRole('button'));
    fireEvent.click(screen.getByText('See how blocking works'));
    expect(requestSettingsTab).toHaveBeenCalledWith('tracking');
  });

  it('stops click propagation so clicking the glyph does not open the message', () => {
    const onRowClick = vi.fn();
    render(
      <div onClick={onRowClick}>
        <TrackerAlertIcon info={ONE} blocked={false} />
      </div>
    );
    fireEvent.click(screen.getByRole('button'));
    expect(onRowClick).not.toHaveBeenCalled();
  });
});

describe('getThreadTrackerInfo', () => {
  it('is null for a thread with nothing to report', () => {
    expect(getThreadTrackerInfo([])).toBeNull();
    expect(getThreadTrackerInfo(null)).toBeNull();
    expect(getThreadTrackerInfo([{ uid: 1 }, { uid: 2, _trackerInfo: null }])).toBeNull();
  });

  it('sums the counts and de-duplicates the vendors across the thread', () => {
    const merged = getThreadTrackerInfo([
      { uid: 1, _trackerInfo: { count: 1, vendors: ['MailChimp'] } },
      { uid: 2 },
      { uid: 3, _trackerInfo: { count: 2, vendors: ['MailChimp', 'SendGrid'] } },
    ]);
    expect(merged).toEqual({ count: 3, vendors: ['MailChimp', 'SendGrid'] });
  });
});
