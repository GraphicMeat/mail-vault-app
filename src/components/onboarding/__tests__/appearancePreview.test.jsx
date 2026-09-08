// src/components/onboarding/__tests__/appearancePreview.test.jsx
// @vitest-environment jsdom

import { describe, it, expect, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, within } from '@testing-library/react';
import { t } from '../../../i18n';
import { getEmailColors } from '../../../utils/mailChrome';
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
  //
  // It used to assert the reading pane was DROPPED in two-column, which was
  // green and wrong: `App.jsx` keeps the reader in both layouts and only swaps
  // the container between row and column. The preview matched the assertion
  // instead of the app, so picking two-column looked like picking to have
  // nowhere to read a message.
  it('keeps the reading pane in both layouts and only changes where it sits', () => {
    const { rerender } = render(<AppearancePreview {...base} />);
    expect(screen.getByTestId('preview-pane-viewer')).toBeTruthy();
    expect(screen.getByTestId('preview-panes').className).toContain('flex-row');

    rerender(<AppearancePreview {...base} layoutMode="two-column" />);
    expect(screen.getByTestId('preview-pane-viewer')).toBeTruthy();
    expect(screen.getByTestId('preview-panes').className).toContain('flex-col');
    expect(screen.getByTestId('preview-panes').dataset.layout).toBe('two-column');
  });

  // Stacked means the list sits ON TOP of the reader, which is the arrangement
  // `App.jsx` produces with `flex-col` and a bottom border on the list.
  it('puts the list above the reader when stacked', () => {
    render(<AppearancePreview {...base} layoutMode="two-column" />);
    const panes = screen.getByTestId('preview-panes');
    const order = [...panes.children].map(c => c.dataset.testid || c.getAttribute('data-testid'));
    expect(order).toEqual(['preview-list', 'preview-pane-viewer']);
  });

  it('shows message bodies in a full Chat topic instead of email columns', () => {
    render(<AppearancePreview {...base} viewStyle="chat" />);
    expect(screen.queryByTestId('preview-list')).toBeNull();
    expect(screen.queryByTestId('preview-pane-viewer')).toBeNull();
    const chat = within(screen.getByTestId('preview-chat'));
    expect(chat.getByText(t('settings.preview.question'))).toBeTruthy();
    expect(chat.getByText(t('settings.preview.answer'))).toBeTruthy();
  });

  it('demonstrates grouped, expanded and separate messages', () => {
    const { rerender, container } = render(<AppearancePreview {...base} />);
    expect(within(screen.getByTestId('preview-list')).getByText('Nell, Rowan')).toBeTruthy();
    expect(container.querySelectorAll('.onboarding-sample-nested')).toHaveLength(0);
    rerender(<AppearancePreview {...base} threadMode="expandable" />);
    expect(container.querySelectorAll('.onboarding-sample-nested')).toHaveLength(3);
    rerender(<AppearancePreview {...base} threadMode="flat" />);
    expect(within(screen.getByTestId('preview-list')).queryByText('Nell, Rowan')).toBeNull();
    expect(within(screen.getByTestId('preview-list')).getAllByText(t('settings.preview.subject'))).toHaveLength(3);
  });

  it('uses the real email palette and exposes everyday actions without interactive demo controls', () => {
    const { container } = render(<AppearancePreview {...base} palette="graphite" theme="dark" />);
    const body = container.querySelector('[data-email-theme]');
    const swatch = document.createElement('div');
    swatch.style.backgroundColor = getEmailColors('dark', 'graphite').background;
    expect(body.style.backgroundColor).toBe(swatch.style.backgroundColor);
    const actions = within(screen.getByTestId('preview-actions'));
    for (const key of ['emailActionBar.move', 'emailActionBar.markUnread', 'emailActionBar.star', 'common.export']) expect(actions.getByRole('img', { name: t(key) })).toBeTruthy();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('reports the sidebar style and density it was given', () => {
    render(<AppearancePreview {...base} sidebarStyle="tagcloud" emailListStyle="compact" />);
    expect(screen.getByTestId('preview-pane-sidebar').dataset.style).toBe('tagcloud');
    expect(screen.getByTestId('preview-list').dataset.density).toBe('compact');
  });
});
