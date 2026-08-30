// src/components/onboarding/__tests__/freeFeatures.test.jsx
// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { FreeFeatures } from '../FreeFeatures';

afterEach(cleanup);

describe('free features step', () => {
  it('names four things that cost nothing', () => {
    render(<FreeFeatures onContinue={() => {}} />);
    expect(screen.getAllByTestId(/^free-feature-/)).toHaveLength(4);
  });

  it('continues', () => {
    const onContinue = vi.fn();
    render(<FreeFeatures onContinue={onContinue} />);
    fireEvent.click(screen.getByTestId('onboarding-continue'));
    expect(onContinue).toHaveBeenCalled();
  });
});
