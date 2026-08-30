// src/components/onboarding/__tests__/appearancePreview.test.jsx
// @vitest-environment jsdom

import { describe, it, expect, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import { PREVIEW_ACCOUNTS } from '../../../data/previewMail.js';
import { AppearancePreview } from '../AppearancePreview';

afterEach(cleanup);

const base = { layoutMode: 'three-column', sidebarStyle: 'list', viewStyle: 'list', emailListStyle: 'default' };

describe('appearance preview', () => {
  it('shows the three demo accounts', () => {
    render(<AppearancePreview {...base} />);
    expect(PREVIEW_ACCOUNTS).toHaveLength(3);
    for (const a of PREVIEW_ACCOUNTS) {
      expect(screen.getByText(a.name)).toBeTruthy();
    }
  });

  // This is the assertion that keeps the preview honest: it is a drawing of the
  // app, and the one thing it must not lie about is the layout being chosen.
  it('drops the reading pane in two-column', () => {
    const { rerender } = render(<AppearancePreview {...base} />);
    expect(screen.getByTestId('preview-pane-viewer')).toBeTruthy();
    rerender(<AppearancePreview {...base} layoutMode="two-column" />);
    expect(screen.queryByTestId('preview-pane-viewer')).toBeNull();
  });

  it('swaps rows for bubbles in chat view', () => {
    const { rerender } = render(<AppearancePreview {...base} />);
    expect(screen.getByTestId('preview-list').dataset.view).toBe('list');
    rerender(<AppearancePreview {...base} viewStyle="chat" />);
    expect(screen.getByTestId('preview-list').dataset.view).toBe('chat');
  });

  it('reports the sidebar style and density it was given', () => {
    render(<AppearancePreview {...base} sidebarStyle="tagcloud" emailListStyle="compact" />);
    expect(screen.getByTestId('preview-pane-sidebar').dataset.style).toBe('tagcloud');
    expect(screen.getByTestId('preview-list').dataset.density).toBe('compact');
  });
});
