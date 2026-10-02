// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { attachPeekToDocument, usePrivateSegments, usePrivateAttr } from '../usePrivacy';
import { setPrivacyDictionary } from '../../utils/privacy/privacyDictionary';
import { buildNameDictionary } from '../../utils/privacy/piiDetector';
import { usePrivacyStore } from '../../stores/privacyStore';

describe('attachPeekToDocument', () => {
  let detach;
  beforeEach(() => {
    vi.useFakeTimers();
    usePrivacyStore.setState({ enabled: true, peek: false });
    detach = attachPeekToDocument(document);
  });
  afterEach(() => { detach(); vi.useRealTimers(); });

  const key = (type, k) => document.dispatchEvent(new KeyboardEvent(type, { key: k, bubbles: true }));

  it('holding Option peeks, releasing masks again', () => {
    key('keydown', 'Alt');
    vi.advanceTimersByTime(300);
    expect(usePrivacyStore.getState().peek).toBe(true);
    key('keyup', 'Alt');
    expect(usePrivacyStore.getState().peek).toBe(false);
  });
  it('losing window blur ends a peek', () => {
    key('keydown', 'Alt');
    vi.advanceTimersByTime(300);
    window.dispatchEvent(new Event('blur'));
    expect(usePrivacyStore.getState().peek).toBe(false);
  });
  it('stops listening once detached', () => {
    detach();
    key('keydown', 'Alt');
    vi.advanceTimersByTime(300);
    expect(usePrivacyStore.getState().peek).toBe(false);
  });
});

describe('captureReveal', () => {
  const join = (segments) => segments.map(s => s.text).join('');
  beforeEach(() => {
    vi.spyOn(usePrivacyStore.persist, 'hasHydrated').mockReturnValue(true);
    usePrivacyStore.setState({ enabled: true, peek: false, captureMask: false, captureReveal: null });
    setPrivacyDictionary(buildNameDictionary({ names: ['Prize Desk', 'Joanna Kowalczyk'] }), { ready: true });
  });
  afterEach(() => {
    usePrivacyStore.setState({ enabled: false, captureReveal: null });
    vi.restoreAllMocks();
  });

  it('the setter stores one lowercased trimmed Set, and null clears it; it is not persisted', () => {
    usePrivacyStore.getState().setCaptureReveal([' Win@Prize.Example ', 'Prize Desk']);
    expect([...usePrivacyStore.getState().captureReveal]).toEqual(['win@prize.example', 'prize desk']);
    usePrivacyStore.getState().setCaptureReveal(new Set(['A@b.co']));
    expect([...usePrivacyStore.getState().captureReveal]).toEqual(['a@b.co']);
    usePrivacyStore.getState().setCaptureReveal(null);
    expect(usePrivacyStore.getState().captureReveal).toBeNull();
    const persisted = usePrivacyStore.persist.getOptions().partialize(usePrivacyStore.getState());
    expect(Object.keys(persisted)).toEqual(['enabled']);
  });

  it('a name or an email whose whole text is in the set renders unmasked, then masked again once cleared', () => {
    const { result: email } = renderHook(() => usePrivateSegments('Win@Prize.example', 'email'));
    const { result: name } = renderHook(() => usePrivateSegments('Prize Desk', 'name'));
    expect(join(email.current)).toBe('xxx@xxxxx.xxxxxxx');
    act(() => usePrivacyStore.getState().setCaptureReveal(['win@prize.example', 'prize desk']));
    expect(email.current).toEqual([{ text: 'Win@Prize.example', masked: false }]);
    expect(name.current).toEqual([{ text: 'Prize Desk', masked: false }]);
    act(() => usePrivacyStore.getState().setCaptureReveal(null));
    expect(join(email.current)).toBe('xxx@xxxxx.xxxxxxx');
    expect(join(name.current)).toBe('xxxxx xxxx');
  });

  it('is exact for the structural kinds: a longer value, another kind and another address stay masked', () => {
    act(() => usePrivacyStore.getState().setCaptureReveal(['win@prize.example']));
    expect(join(renderHook(() => usePrivateSegments('xwin@prize.example', 'email')).result.current)).toBe('xxxx@xxxxx.xxxxxxx');
    expect(join(renderHook(() => usePrivateSegments('other@prize.example', 'email')).result.current)).toBe('xxxxx@xxxxx.xxxxxxx');
    // The filename kind is never revealable.
    expect(join(renderHook(() => usePrivateSegments('win@prize.example', 'filename')).result.current)).toBe('xxx@xxxxx.xxxxxxx');
  });

  it('a text value drops only the revealed email span; a contact name beside it stays masked', () => {
    act(() => usePrivacyStore.getState().setCaptureReveal(['win@prize.example']));
    const { result } = renderHook(() => usePrivateSegments('Joanna Kowalczyk wrote from win@prize.example', 'text'));
    expect(join(result.current)).toBe('xxxxxx xxxxxxxxx wrote from win@prize.example');
    expect(result.current.filter(s => s.masked).map(s => s.text)).toEqual(['xxxxxx xxxxxxxxx']);
  });

  it('usePrivateAttr follows the same rule', () => {
    const { result } = renderHook(() => usePrivateAttr());
    expect(result.current('win@prize.example', 'email')).toBe('xxx@xxxxx.xxxxxxx');
    act(() => usePrivacyStore.getState().setCaptureReveal(['win@prize.example']));
    expect(result.current('win@prize.example', 'email')).toBe('win@prize.example');
    expect(result.current('Joanna Kowalczyk <win@prize.example>', 'text')).toBe('xxxxxx xxxxxxxxx <win@prize.example>');
    expect(result.current('other@prize.example', 'email')).toBe('xxxxx@xxxxx.xxxxxxx');
    act(() => usePrivacyStore.getState().setCaptureReveal(null));
    expect(result.current('win@prize.example', 'email')).toBe('xxx@xxxxx.xxxxxxx');
  });
});
