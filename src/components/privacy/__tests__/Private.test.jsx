// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, renderHook, act, cleanup } from '@testing-library/react';
import { Private } from '../Private';
import { usePrivacyActive } from '../../../hooks/usePrivacy';
import { usePrivacyStore } from '../../../stores/privacyStore';
import { setPrivacyDictionary } from '../../../utils/privacy/privacyDictionary';
import { buildNameDictionary } from '../../../utils/privacy/piiDetector';

afterEach(cleanup);
beforeEach(() => {
  usePrivacyStore.setState({ enabled: false, peek: false, captureMask: false });
  setPrivacyDictionary(buildNameDictionary({ names: ['John Smith'] }), { ready: true });
});

describe('<Private>', () => {
  it('renders plain text when privacy is off', () => {
    const { container } = render(<Private kind="name">John Smith</Private>);
    expect(container.textContent).toBe('John Smith');
  });
  it('masks the whole value for structural kinds in the first render', () => {
    usePrivacyStore.setState({ enabled: true });
    const { container } = render(<Private kind="name">Unknown Person</Private>);
    expect(container.textContent).toBe('xxxxxxx xxxxxx');
    expect(container.innerHTML).not.toContain('Unknown');
  });
  it('masks only detected spans for kind="text"', () => {
    usePrivacyStore.setState({ enabled: true });
    const { container } = render(<Private kind="text">Lunch with John Smith?</Private>);
    expect(container.textContent).toBe('Lunch with xxxx xxxxx?');
  });
  it('keeps a filename extension', () => {
    usePrivacyStore.setState({ enabled: true });
    const { container } = render(<Private kind="filename">Jane Roe CV.pdf</Private>);
    expect(container.textContent).toBe('xxxx xxx xx.pdf');
  });
  it('peek reveals, release masks again', () => {
    usePrivacyStore.setState({ enabled: true });
    const { container } = render(<Private kind="email">a@b.co</Private>);
    act(() => usePrivacyStore.setState({ peek: true }));
    expect(container.textContent).toBe('a@b.co');
    act(() => usePrivacyStore.setState({ peek: false }));
    expect(container.textContent).toBe('x@x.xx');
  });
});

describe('usePrivacyActive in a detached window', () => {
  let hydrated;
  let listeners;
  beforeEach(() => {
    hydrated = false;
    listeners = [];
    window.history.replaceState(null, '', '/?compose=1');
    vi.spyOn(usePrivacyStore.persist, 'hasHydrated').mockImplementation(() => hydrated);
    vi.spyOn(usePrivacyStore.persist, 'onFinishHydration').mockImplementation((cb) => {
      listeners.push(cb);
      return () => { listeners = listeners.filter(l => l !== cb); };
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState(null, '', '/');
  });

  it('masks until the persisted choice has loaded, then follows it', () => {
    const { result } = renderHook(() => usePrivacyActive());
    expect(result.current).toBe(true);
    hydrated = true;
    act(() => listeners.forEach(l => l()));
    expect(result.current).toBe(false);
  });
  it('masks nothing early in the main window', () => {
    window.history.replaceState(null, '', '/');
    const { result } = renderHook(() => usePrivacyActive());
    expect(result.current).toBe(false);
  });
});
