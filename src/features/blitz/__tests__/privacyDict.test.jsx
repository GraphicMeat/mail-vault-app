// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const state = vi.hoisted(() => ({ active: false, ready: true }));
vi.mock('../../../hooks/usePrivacy', () => ({ usePrivacyActive: () => state.active }));
vi.mock('../../../utils/privacy/privacyDictionary', () => ({
  usePrivacyDictStore: (sel) => sel({ version: 1 }),
  getPrivacyDictionary: () => ({ names: ['Global'] }),
  isPrivacyDictionaryReady: () => state.ready,
  collectPrivacyNames: ({ emails }) => (emails?.length ? ['Own'] : []),
}));
vi.mock('../../../utils/privacy/piiDetector', () => ({
  buildNameDictionary: ({ names }) => ({ names }),
  unionDictionaries: (a, b) => ({ names: [...(a?.names ?? []), ...(b?.names ?? [])] }),
}));
import { usePrivacyDict } from '../prepass/privacyDict';

beforeEach(() => { state.active = false; state.ready = true; vi.useRealTimers(); });

describe('usePrivacyDict', () => {
  it('is inactive and never holds when privacy is off', () => {
    const { result } = renderHook(() => usePrivacyDict({ message: null }));
    expect(result.current).toEqual(expect.objectContaining({ active: false, hold: false }));
  });
  it('active: global dictionary plus the message’s own parties', () => {
    state.active = true;
    const { result } = renderHook(() => usePrivacyDict({ message: { uid: 1 } }));
    expect(result.current.hold).toBe(false);
    expect(result.current.dict.names).toEqual(['Global', 'Own']);
  });
  it('holds while the dictionary loads, then releases after the timeout', () => {
    vi.useFakeTimers();
    state.active = true; state.ready = false;
    const { result } = renderHook(() => usePrivacyDict({ message: null, readyTimeoutMs: 300 }));
    expect(result.current.hold).toBe(true);
    act(() => { vi.advanceTimersByTime(400); });
    expect(result.current.hold).toBe(false);
  });
});
