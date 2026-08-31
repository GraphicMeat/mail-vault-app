// src/components/onboarding/__tests__/freeFeatures.test.jsx
// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { FreeFeatures } from '../FreeFeatures';
import { LEGEND_ENTRIES } from '../../email/stateLegend.jsx';
import { SAFETY_ALERTS } from '../../../data/safetyAlerts.js';

afterEach(cleanup);

describe('free features step', () => {
  it('names four things that cost nothing', () => {
    render(<FreeFeatures onContinue={() => {}} />);
    expect(screen.getAllByTestId(/^free-feature-/)).toHaveLength(4);
  });

  // Every claim gets a drawing. A card with prose and no sample is the state the
  // step shipped in, and it is the reason the icons needed explaining at all.
  it('gives every feature a sample', () => {
    render(<FreeFeatures onContinue={() => {}} />);
    expect(screen.getAllByTestId(/^free-sample-/)).toHaveLength(4);
    for (const id of ['vault', 'chat', 'search', 'link-safety']) {
      expect(screen.getByTestId(`free-sample-${id}`), id).toBeTruthy();
    }
  });

  // The vault legend is not a copy — it renders LEGEND_ENTRIES, the same array
  // the mail list's own footer legend uses, so the tour cannot drift from it.
  it('teaches the real vault marks, from the real legend', () => {
    render(<FreeFeatures onContinue={() => {}} />);
    const ids = LEGEND_ENTRIES().map(e => e.id);
    expect(ids.length).toBe(4);
    for (const id of ids) {
      expect(screen.getByTestId(`free-legend-${id}`), id).toBeTruthy();
    }
  });

  // The warning card renders SAFETY_ALERTS — the app's own alert titles — not
  // the four labels this step used to invent for itself.
  it('names every real warning mark', () => {
    render(<FreeFeatures onContinue={() => {}} />);
    for (const a of SAFETY_ALERTS) {
      expect(screen.getByTestId(`safety-alert-${a.id}`), a.id).toBeTruthy();
    }
    expect(screen.getByTestId('free-sample-link-safety').textContent)
      .toContain('Sender impersonation detected');
  });

  // A search sample that highlights nothing does not show search working.
  it('shows a query and the rows it matched', () => {
    render(<FreeFeatures onContinue={() => {}} />);
    const sample = screen.getByTestId('free-sample-search');
    const marks = sample.querySelectorAll('mark');
    expect(marks.length).toBeGreaterThan(0);
    for (const m of marks) expect(m.textContent).toContain('MeatPad');
  });

  it('continues', () => {
    const onContinue = vi.fn();
    render(<FreeFeatures onContinue={onContinue} />);
    fireEvent.click(screen.getByTestId('onboarding-continue'));
    expect(onContinue).toHaveBeenCalled();
  });
});
