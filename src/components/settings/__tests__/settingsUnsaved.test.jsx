// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useMailStore } from '../../../stores/mailStore';
import { useUnsavedStore } from '../../../stores/unsavedStore';
import { SettingsPage } from '../../SettingsPage';

vi.mock('../../../services/db', () => ({ getCachedMailboxes: async () => [], saveAccount: async () => {} }));

const page = () => screen.getByTestId('settings-content').dataset.page;
const nav = name => within(screen.getByRole('navigation')).getByRole('button', { name });

beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })));
  useMailStore.setState({ accounts: [], activeAccountId: null });
  useUnsavedStore.setState({ guard: null, pending: null, busy: false });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const holdChanges = () => useUnsavedStore.getState().setGuard({
  changes: ['View name', 'Contains'], save: vi.fn(async () => true), discard: vi.fn(async () => {}),
});

it('leaving a page with unsaved changes asks first and lists them', async () => {
  render(<SettingsPage initialTab="language" onClose={() => {}} />);
  holdChanges();
  fireEvent.click(nav('Privacy & security'));
  expect(page()).toBe('appearance');
  const dialog = await screen.findByTestId('unsaved-changes');
  expect(within(dialog).getByTestId('unsaved-list').textContent).toBe('View nameContains');
  fireEvent.click(within(dialog).getByTestId('unsaved-keep'));
  expect(page()).toBe('appearance');
  expect(screen.queryByTestId('unsaved-changes')).toBeNull();

  fireEvent.click(nav('Privacy & security'));
  fireEvent.click(await screen.findByTestId('unsaved-discard'));
  await vi.waitFor(() => expect(page()).toBe('security'));
});

it('closing Settings with unsaved changes waits for the answer', async () => {
  const onClose = vi.fn();
  render(<SettingsPage initialTab="language" onClose={onClose} />);
  holdChanges();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.click(await screen.findByTestId('unsaved-save'));
  await vi.waitFor(() => expect(onClose).toHaveBeenCalledOnce());
});

it('with nothing unsaved, pages switch at once', () => {
  render(<SettingsPage initialTab="language" onClose={() => {}} />);
  fireEvent.click(nav('Privacy & security'));
  expect(page()).toBe('security');
  expect(screen.queryByTestId('unsaved-changes')).toBeNull();
});

it('detaching Settings with unsaved changes asks first', async () => {
  const onDetach = vi.fn();
  render(<SettingsPage initialTab="language" onClose={() => {}} onDetach={onDetach} />);
  holdChanges();
  fireEvent.click(screen.getByTestId('settings-detach'));
  expect(onDetach).not.toHaveBeenCalled();
  fireEvent.click(await screen.findByTestId('unsaved-discard'));
  await vi.waitFor(() => expect(onDetach).toHaveBeenCalledOnce());
});
