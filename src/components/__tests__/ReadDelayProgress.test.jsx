// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { useMailStore } from '../../stores/mailStore';
import { ReadDelayProgress } from '../ReadDelayProgress';

afterEach(() => {
  cleanup();
  useMailStore.setState({ markReadProgress: null });
});

it('shows the selected email read countdown with its configured duration', () => {
  useMailStore.setState({ markReadProgress: { startedAt: 1000, endsAt: 5000 } });
  render(<ReadDelayProgress />);
  const progress = screen.getByRole('progressbar', { name: 'Marking as read' });
  expect(progress.style.getPropertyValue('--read-delay-duration')).toBe('4000ms');
});

it('renders nothing without a pending delayed mark', () => {
  useMailStore.setState({ markReadProgress: null });
  const { container } = render(<ReadDelayProgress />);
  expect(container.innerHTML).toBe('');
});
