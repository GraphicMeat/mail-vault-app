// @vitest-environment jsdom
// Settings > Appearance > Layout on the phone carries desktop's folder icon control (the same
// WorkspaceView row), over the phone's `folderIconStyle`, with a sample of folders that follows the
// choice and a hint that names the phone's way to pick one folder's colour.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup, fireEvent, act, within } from '@testing-library/react';
import { installMockEngine } from './fixtures/mockEngine.js';

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };

let t;
let Appearance;
let useMobileStore;
let PREF_DEFAULTS;

beforeAll(async () => {
  installMockEngine();
  ({ t } = await import('../i18n.js'));
  ({ default: Appearance } = await import('../settings/Appearance.jsx'));
  ({ useMobileStore } = await import('../store.js'));
  ({ PREF_DEFAULTS } = await import('../prefs.js'));
});
beforeEach(() => {
  installMockEngine();
  useMobileStore.setState({ prefs: { ...PREF_DEFAULTS } });
});
afterEach(cleanup);

const settle = () => act(async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); });
const label = (root, name) => [...root.querySelectorAll('.setting-row-copy > :first-child')].find((l) => l.textContent === name);

async function layout() {
  const view = render(<Appearance section="layout" />);
  await settle();
  return view.container;
}

describe('the folder icons row', () => {
  it('is on the phone: colourful or theme, saved as the phone preference', async () => {
    const root = await layout();
    const title = label(root, t('workspace.folderIcons'));
    expect(title).toBeTruthy();
    const group = title.closest('.setting-row');
    const buttons = within(group).getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual([t('workspace.folderIconsColorful'), t('workspace.folderIconsTheme')]);
    expect(buttons[0].getAttribute('aria-pressed')).toBe('true');
    await act(async () => { fireEvent.click(buttons[1]); });
    await settle();
    expect(useMobileStore.getState().prefs.folderIconStyle).toBe('theme');
  });

  it('names the phone\'s way to colour one folder, not a right click', async () => {
    const root = await layout();
    const group = label(root, t('workspace.folderIcons')).closest('.setting-row');
    expect(group.textContent).toContain(t('mobile.drawer.folderIconsColorfulHint'));
    expect(group.textContent).not.toContain('Right-click');
  });

  it('draws a sample of folders in the chosen look', async () => {
    const root = await layout();
    const sample = () => [...root.querySelectorAll('.preview-folder-sample .preview-folder-sample-row svg')].map((s) => s.style.color);
    expect(sample().length).toBeGreaterThanOrEqual(4);
    expect(new Set(sample()).size).toBeGreaterThan(1);
    await act(async () => { useMobileStore.setState({ prefs: { ...useMobileStore.getState().prefs, folderIconStyle: 'theme' } }); });
    await settle();
    expect(new Set(sample())).toEqual(new Set(['var(--mail-accent-text)']));
  });
});
