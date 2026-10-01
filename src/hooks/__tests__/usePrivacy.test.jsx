// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { attachPeekToDocument } from '../usePrivacy';
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
