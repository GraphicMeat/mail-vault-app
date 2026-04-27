// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

// Mock lucide-react icons
vi.mock('lucide-react', () => {
  const icon = (name) => (props) => React.createElement('span', { 'data-icon': name, ...props });
  return {
    AlertTriangle: icon('AlertTriangle'),
    ExternalLink: icon('ExternalLink'),
    X: icon('X'),
  };
});

import { LinkSafetyModal } from '../LinkSafetyModal';

const mockAlert = {
  level: 'yellow',
  reason: 'Link text shows a different domain than the actual URL',
  textContent: 'https://example.com',
  actualUrl: 'https://phishing-site.com/login',
};

describe('LinkSafetyModal', () => {
  afterEach(() => cleanup());

  it('renders nothing when alert is null', () => {
    const { container } = render(
      <LinkSafetyModal alert={null} onCancel={vi.fn()} onOpenAnyway={vi.fn()} />
    );
    expect(container.innerHTML).toBe('');
  });

  it('renders modal content when alert is provided', () => {
    render(
      <LinkSafetyModal alert={mockAlert} onCancel={vi.fn()} onOpenAnyway={vi.fn()} />
    );
    expect(screen.getByText('Suspicious Link Detected')).toBeTruthy();
    expect(screen.getAllByText(/phishing-site\.com/).length).toBeGreaterThan(0);
  });

  it('renders red variant for dangerous links', () => {
    const redAlert = { ...mockAlert, level: 'red' };
    render(
      <LinkSafetyModal alert={redAlert} onCancel={vi.fn()} onOpenAnyway={vi.fn()} />
    );
    expect(screen.getByText('Dangerous Link Detected')).toBeTruthy();
  });

  it('calls onCancel when Escape is pressed', () => {
    const onCancel = vi.fn();
    render(
      <LinkSafetyModal alert={mockAlert} onCancel={onCancel} onOpenAnyway={vi.fn()} />
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('calls onCancel when Cancel button is clicked', () => {
    const onCancel = vi.fn();
    render(
      <LinkSafetyModal alert={mockAlert} onCancel={onCancel} onOpenAnyway={vi.fn()} />
    );
    fireEvent.click(screen.getByText('Cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('calls onOpenAnyway when Open Anyway button is clicked', () => {
    const onOpenAnyway = vi.fn();
    render(
      <LinkSafetyModal alert={mockAlert} onCancel={vi.fn()} onOpenAnyway={onOpenAnyway} />
    );
    fireEvent.click(screen.getByText('Open Anyway'));
    expect(onOpenAnyway).toHaveBeenCalledTimes(1);
  });
});
