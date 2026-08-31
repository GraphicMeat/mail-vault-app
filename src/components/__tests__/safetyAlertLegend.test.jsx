// src/components/__tests__/safetyAlertLegend.test.jsx
// @vitest-environment jsdom

import { describe, it, expect, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, within } from '@testing-library/react';
import en from '../../i18n/locales/en.json';
import { SAFETY_ALERTS, TONE_CLASS } from '../../data/safetyAlerts.js';
import { SafetyAlertLegend } from '../SafetyAlertLegend.jsx';

afterEach(cleanup);

describe('safety alert catalog', () => {
  it('covers every mark the app can put on a message', () => {
    expect(SAFETY_ALERTS.map(a => a.id)).toEqual([
      'link-dangerous', 'link-suspicious',
      'sender-impersonation', 'sender-suspicious-name',
      'reply-to-mismatch',
      'tracker-blocked', 'tracker-loaded',
    ]);
  });

  /**
   * The whole point of the catalog. The tour previously taught four labels of
   * its own invention — "Dangerous", "Suspicious", "Reply-To mismatch",
   * "Tracking pixel" — none of which the app ever displays. Every title here
   * must be a key some alert component actually renders.
   */
  it('uses only keys that exist in the catalog', () => {
    for (const a of SAFETY_ALERTS) {
      const title = a.count === undefined ? a.titleKey : null;
      if (title) expect(en[title], a.id).toBeTruthy();
      // Count-formatted strings live under the bare key or a _one/_other pair.
      if (a.count !== undefined) {
        expect(en[a.titleKey] ?? en[`${a.titleKey}_other`], a.id).toBeTruthy();
      }
      expect(en[a.blurbKey] ?? en[`${a.blurbKey}_other`], `${a.id} blurb`).toBeTruthy();
    }
  });

  it('gives every alert a tone that has a colour', () => {
    for (const a of SAFETY_ALERTS) expect(TONE_CLASS[a.tone], a.id).toBeTruthy();
  });

  it('names a screenshot for every alert', () => {
    for (const a of SAFETY_ALERTS) expect(a.shot, a.id).toBeTruthy();
  });
});

describe('safety alert legend', () => {
  it('renders every alert', () => {
    render(<SafetyAlertLegend />);
    for (const a of SAFETY_ALERTS) {
      expect(screen.getByTestId(`safety-alert-${a.id}`), a.id).toBeTruthy();
    }
  });

  // Rokas asked for these three by name. They are the exact strings the alert
  // dialogs show, and "(4)" is his own example of the count-formatted one.
  it('shows the real alert titles, count and all', () => {
    render(<SafetyAlertLegend />);
    const legend = screen.getByTestId('safety-legend');
    expect(within(legend).getByText('Reply-To domain mismatch')).toBeTruthy();
    expect(within(legend).getByText('Sender impersonation detected')).toBeTruthy();
    expect(within(legend).getByText('Tracking blocked (4)')).toBeTruthy();
  });

  // A count-formatted string rendered without its variable shows the raw
  // "{{count}}" — or, worse, silently renders the key.
  it('never leaks an unfilled placeholder or a raw key', () => {
    render(<SafetyAlertLegend />);
    const text = screen.getByTestId('safety-legend').textContent;
    expect(text).not.toMatch(/\{\{/);
    expect(text).not.toMatch(/\balert\.[a-z]/i);
    expect(text).not.toMatch(/\bsafety\.[a-z]/i);
  });

  // Compact is the onboarding tile. Truncating there is what the e2e clipping
  // guard flags, and "Sender impersonation detected" does not fit half a line.
  it('wraps rather than truncates in compact mode', () => {
    render(<SafetyAlertLegend compact />);
    const legend = screen.getByTestId('safety-legend');
    for (const el of legend.querySelectorAll('*')) {
      expect(el.getAttribute('class') || '').not.toMatch(/\btruncate\b/);
    }
  });

  it('explains each alert, not just names it', () => {
    render(<SafetyAlertLegend />);
    for (const a of SAFETY_ALERTS) {
      const row = screen.getByTestId(`safety-alert-${a.id}`);
      const p = row.querySelector('p');
      expect(p, a.id).toBeTruthy();
      expect(p.textContent.length, a.id).toBeGreaterThan(20);
    }
  });

  // Two pairs share one capture; rendering it twice is repetition, not
  // information.
  it('shows each screenshot at most once', () => {
    render(<SafetyAlertLegend showShots locale="en" />);
    const imgs = [...screen.getByTestId('safety-legend').querySelectorAll('img')];
    const shots = imgs.map(i => i.getAttribute('data-testid'));
    expect(new Set(shots).size).toBe(shots.length);
  });
});
