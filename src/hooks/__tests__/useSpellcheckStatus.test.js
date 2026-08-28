// @vitest-environment jsdom
//
// The status crosses the Tauri boundary once per app run. What matters is that
// a build without the command (or a browser preview) answers "the OS handles
// it" rather than "no dictionary" — the second would nag every macOS user.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { loadSpellcheckStatus, useSpellcheckStatus, resetSpellcheckStatusCache } from '../useSpellcheckStatus';

const NATIVE = { needsDictionary: false, dictionaries: [], confined: false };

beforeEach(() => {
  resetSpellcheckStatusCache();
  delete window.__TAURI__;
});

describe('useSpellcheckStatus', () => {
  it('answers "the OS handles it" with no Tauri around, on the first render', () => {
    const { result } = renderHook(() => useSpellcheckStatus());
    expect(result.current).toEqual(NATIVE);   // not null: no flicker, no state update
  });

  it('asks Rust once however many editors are open', async () => {
    const invoke = vi.fn().mockResolvedValue({ needsDictionary: true, dictionaries: ['lt_LT'], confined: false });
    window.__TAURI__ = { core: { invoke } };

    const a = renderHook(() => useSpellcheckStatus());
    const b = renderHook(() => useSpellcheckStatus());
    await waitFor(() => expect(a.result.current).not.toBeNull());
    await waitFor(() => expect(b.result.current).not.toBeNull());

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('spellcheck_status');
    expect(a.result.current.dictionaries).toEqual(['lt_LT']);
  });

  it('treats a build too old to know the command as native, not as a missing dictionary', async () => {
    window.__TAURI__ = { core: { invoke: vi.fn().mockRejectedValue(new Error('unknown command')) } };
    await expect(loadSpellcheckStatus()).resolves.toEqual(NATIVE);
  });
});
