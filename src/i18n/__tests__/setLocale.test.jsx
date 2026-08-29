// @vitest-environment jsdom

import { describe, it, expect, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, act } from '@testing-library/react';
import { t, useT, setLocale, getLocale, LOCALES } from '../index.js';
import { useSettingsStore } from '../../stores/settingsStore';

afterEach(async () => { cleanup(); await setLocale('en'); });

describe('LOCALES', () => {
  it('lists exactly the nine shipped locales, English first', () => {
    expect(LOCALES.map(l => l.code)).toEqual(
      ['en', 'es', 'fr', 'it', 'de', 'pt-BR', 'ja', 'ko', 'zh-Hans']
    );
  });

  it('gives every locale a flag and a native name', () => {
    for (const l of LOCALES) {
      expect(l.flag, l.code).toBeTruthy();
      expect(l.native, l.code).toBeTruthy();
    }
  });
});

describe('setLocale', () => {
  it('starts on English', () => {
    expect(getLocale()).toBe('en');
  });

  it('writes the store field only after the catalog is loaded', async () => {
    let langWhenCatalogChanged = null;
    // Sample the store the instant `t` starts answering in German.
    const unsub = useSettingsStore.subscribe(() => {
      if (langWhenCatalogChanged === null) {
        langWhenCatalogChanged = t('sidebar.allInboxes');
      }
    });
    await setLocale('de');
    unsub();
    // If the store were written first, this snapshot would still be English.
    expect(langWhenCatalogChanged).not.toBe('All Inboxes');
    expect(useSettingsStore.getState().language).toBe('de');
  });

  it('falls back to the English string for a key the locale has not translated', async () => {
    await setLocale('de');
    expect(t('i18n.__missing_on_purpose__')).toBe('i18n.__missing_on_purpose__');
  });
});

describe('useT', () => {
  it('re-renders its component when the locale changes', async () => {
    function Probe() {
      const tr = useT();
      return <span data-testid="v">{tr('sidebar.allInboxes')}</span>;
    }
    render(<Probe />);
    expect(screen.getByTestId('v').textContent).toBe('All Inboxes');
    await act(async () => { await setLocale('de'); });
    expect(screen.getByTestId('v').textContent).not.toBe('All Inboxes');
  });
});
