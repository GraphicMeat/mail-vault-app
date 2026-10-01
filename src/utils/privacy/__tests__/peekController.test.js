import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createPeekController } from '../peekController';

const alt = { key: 'Alt' };
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('peekController', () => {
  it('turns on only after Alt is held alone for 250 ms, and off on release', () => {
    const onChange = vi.fn();
    const c = createPeekController({ onChange });
    c.keydown(alt);
    vi.advanceTimersByTime(249);
    expect(onChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onChange).toHaveBeenLastCalledWith(true);
    c.keyup(alt);
    expect(onChange).toHaveBeenLastCalledWith(false);
  });
  it('an Option chord never peeks', () => {
    const onChange = vi.fn();
    const c = createPeekController({ onChange });
    c.keydown(alt); c.keydown({ key: 'e' });
    vi.advanceTimersByTime(1000);
    expect(onChange).not.toHaveBeenCalledWith(true);
  });
  it('a second key while peeking ends the peek', () => {
    const onChange = vi.fn();
    const c = createPeekController({ onChange });
    c.keydown(alt); vi.advanceTimersByTime(300);
    c.keydown({ key: 'Tab' });
    expect(onChange).toHaveBeenLastCalledWith(false);
  });
  it('Cmd-Tab away (blur, no keyup) clears the peek', () => {
    const onChange = vi.fn();
    const c = createPeekController({ onChange });
    c.keydown(alt); vi.advanceTimersByTime(300);
    c.blur();
    expect(onChange).toHaveBeenLastCalledWith(false);
  });
  it('Alt+click cancels', () => {
    const onChange = vi.fn();
    const c = createPeekController({ onChange });
    c.keydown(alt); c.pointerdown(); vi.advanceTimersByTime(1000);
    expect(onChange).not.toHaveBeenCalledWith(true);
  });
  it('auto-repeat keydowns of Alt do not restart the hold', () => {
    const onChange = vi.fn();
    const c = createPeekController({ onChange });
    c.keydown(alt); vi.advanceTimersByTime(200); c.keydown({ key: 'Alt', repeat: true }); vi.advanceTimersByTime(50);
    expect(onChange).toHaveBeenLastCalledWith(true);
  });
  it('after an Option-chord spoils a hold, releasing Alt and pressing it again alone for 250 ms peeks', () => {
    const onChange = vi.fn();
    const c = createPeekController({ onChange });
    c.keydown(alt);
    c.keydown({ key: 'e' });
    c.keyup(alt);
    c.keydown(alt);
    vi.advanceTimersByTime(250);
    expect(onChange).toHaveBeenLastCalledWith(true);
  });
  it('after typing, Alt hold works again', () => {
    const onChange = vi.fn();
    const c = createPeekController({ onChange });
    c.keydown({ key: 'a' });
    c.keyup({ key: 'a' });
    c.keydown(alt);
    vi.advanceTimersByTime(250);
    expect(onChange).toHaveBeenLastCalledWith(true);
  });
  it('after clicking, Alt hold works again', () => {
    const onChange = vi.fn();
    const c = createPeekController({ onChange });
    c.pointerdown();
    c.keydown(alt);
    vi.advanceTimersByTime(250);
    expect(onChange).toHaveBeenLastCalledWith(true);
  });
  it('Cmd-Alt does not peek', () => {
    const onChange = vi.fn();
    const c = createPeekController({ onChange });
    c.keydown({ key: 'Alt', metaKey: true });
    vi.advanceTimersByTime(1000);
    expect(onChange).not.toHaveBeenCalledWith(true);
  });
  it('Alt keyup before 250ms cancels peek', () => {
    const onChange = vi.fn();
    const c = createPeekController({ onChange });
    c.keydown(alt);
    vi.advanceTimersByTime(200);
    c.keyup(alt);
    vi.advanceTimersByTime(100);
    expect(onChange).not.toHaveBeenCalledWith(true);
  });
  it('blur before 250ms cancels peek', () => {
    const onChange = vi.fn();
    const c = createPeekController({ onChange });
    c.keydown(alt);
    vi.advanceTimersByTime(200);
    c.blur();
    vi.advanceTimersByTime(100);
    expect(onChange).not.toHaveBeenCalledWith(true);
  });
  it('repeat Alt keydown while already peeking keeps peek on', () => {
    const onChange = vi.fn();
    const c = createPeekController({ onChange });
    c.keydown(alt);
    vi.advanceTimersByTime(250);
    expect(onChange).toHaveBeenLastCalledWith(true);
    c.keydown({ key: 'Alt', repeat: true });
    expect(onChange).toHaveBeenLastCalledWith(true); // Still on
  });
  it('AltGraph never peeks', () => {
    const onChange = vi.fn();
    const c = createPeekController({ onChange });
    c.keydown({ key: 'AltGraph' });
    vi.advanceTimersByTime(1000);
    expect(onChange).not.toHaveBeenCalledWith(true);
  });
  it('dispose with pending timer never fires', () => {
    const onChange = vi.fn();
    const c = createPeekController({ onChange });
    c.keydown(alt);
    vi.advanceTimersByTime(200);
    c.dispose();
    vi.advanceTimersByTime(100);
    expect(onChange).not.toHaveBeenCalledWith(true);
  });
  it('dispose during live peek turns off', () => {
    const onChange = vi.fn();
    const c = createPeekController({ onChange });
    c.keydown(alt);
    vi.advanceTimersByTime(250);
    expect(onChange).toHaveBeenLastCalledWith(true);
    c.dispose();
    expect(onChange).toHaveBeenLastCalledWith(false);
  });
  it('after dispose, keydown/keyup/pointerdown are no-ops', () => {
    const onChange = vi.fn();
    const c = createPeekController({ onChange });
    c.keydown(alt);
    vi.advanceTimersByTime(250);
    c.dispose();
    onChange.mockClear();
    c.keydown(alt);
    c.keyup(alt);
    c.pointerdown();
    vi.advanceTimersByTime(500);
    expect(onChange).not.toHaveBeenCalled();
  });
  it('keyup of non-Alt key while Alt is held does not start a peek', () => {
    const onChange = vi.fn();
    const c = createPeekController({ onChange });
    c.keydown(alt);
    c.keydown({ key: 'e' });
    c.keyup({ key: 'e' });
    vi.advanceTimersByTime(300);
    expect(onChange).not.toHaveBeenCalledWith(true);
  });
});
