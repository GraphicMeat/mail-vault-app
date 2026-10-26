// @vitest-environment jsdom
/**
 * A social capture of the app window can carry the user's word marks
 * (privacyStore.captureMarks): show leaves a detected word readable, hide masks
 * a missed one, and detect:false (redact box off) masks only hide words. The
 * masked runs name their original through the capture's mask table, so the hit
 * map can say which word a click landed on.
 */
import React from 'react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, renderHook, act, cleanup } from '@testing-library/react';
import { Private } from '../Private';
import { usePrivateAttr } from '../../../hooks/usePrivacy';
import { usePrivacyStore } from '../../../stores/privacyStore';
import { setPrivacyDictionary, getPrivacyDictionary } from '../../../utils/privacy/privacyDictionary';
import { buildNameDictionary } from '../../../utils/privacy/piiDetector';
import { captureMaskOriginal, resetCaptureMasks } from '../../../utils/privacy/captureMasks';

const marks = (extra) => ({ show: new Set(), hide: new Set(), ...extra });
const withMarks = (m) => act(() => usePrivacyStore.getState().setCaptureMarks(m));

beforeEach(() => {
  resetCaptureMasks();
  usePrivacyStore.setState({ enabled: false, peek: false, captureMask: true, captureMarks: null });
  setPrivacyDictionary(buildNameDictionary({ names: ['Ana Brandt'] }), { ready: true });
});
afterEach(() => { cleanup(); usePrivacyStore.setState({ captureMask: false, captureMarks: null }); });

describe('<Private> under capture marks', () => {
  it('without marks nothing changes: a detected name is masked, no mask index is written', () => {
    const { container } = render(<Private kind="text">Hi Ana Brandt</Private>);
    expect(container.textContent).toBe('Hi xxx xxxxxx');
    expect(container.querySelector('[data-mv-i]')).toBeNull();
  });

  it('show leaves one word of a detected name readable, in a text run and in a whole-masked name', () => {
    withMarks(marks({ show: new Set(['ana']) }));
    const a = render(<Private kind="text">Hi Ana Brandt</Private>);
    expect(a.container.textContent).toBe('Hi Ana xxxxxx');
    const b = render(<Private kind="name">Ana Brandt</Private>);
    expect(b.container.textContent).toBe('Ana xxxxxx');
  });

  it('hide masks a word the detector missed', () => {
    withMarks(marks({ hide: new Set(['falcon']) }));
    const { container } = render(<Private kind="text">Project Falcon and Ana</Private>);
    expect(container.textContent).toBe('Project xxxxxx and xxx');
  });

  it('detect:false masks only the hide words: the redact box is off', () => {
    withMarks(marks({ detect: false, hide: new Set(['falcon']) }));
    const text = render(<Private kind="text">Project Falcon and Ana Brandt</Private>);
    expect(text.container.textContent).toBe('Project xxxxxx and Ana Brandt');
    const name = render(<Private kind="name">Ana Brandt</Private>);
    expect(name.container.textContent).toBe('Ana Brandt');
  });

  it('with marks set, every masked run carries an index that gives back its original', () => {
    withMarks(marks());
    const { container } = render(<Private kind="text">Hi Ana Brandt, mail ana@x.co</Private>);
    const originals = [...container.querySelectorAll('[data-mv-i]')].map(el => captureMaskOriginal(Number(el.getAttribute('data-mv-i'))));
    expect(originals).toEqual(['Ana Brandt', 'ana@x.co']);
    expect(container.innerHTML).not.toContain('Brandt');
    const name = render(<Private kind="name">Zed Zed</Private>);
    expect(captureMaskOriginal(Number(name.container.querySelector('[data-mv-i]').getAttribute('data-mv-i')))).toBe('Zed Zed');
  });

  it('a filename masks its stem and the index gives back the stem', () => {
    withMarks(marks());
    const { container } = render(<Private kind="filename">Ana CV.pdf</Private>);
    expect(container.textContent).toBe('xxx xx.pdf');
    expect(captureMaskOriginal(Number(container.querySelector('[data-mv-i]').getAttribute('data-mv-i')))).toBe('Ana CV');
  });

  it('a change of marks re-masks what is on screen', () => {
    withMarks(marks());
    const { container } = render(<Private kind="text">Hi Ana Brandt</Private>);
    expect(container.textContent).toBe('Hi xxx xxxxxx');
    withMarks(marks({ show: new Set(['ana', 'brandt']) }));
    expect(container.textContent).toBe('Hi Ana Brandt');
    withMarks(null);
    expect(container.textContent).toBe('Hi xxx xxxxxx');
  });

  it('attributes follow the marks too', () => {
    withMarks(marks({ show: new Set(['ana']) }));
    const { result } = renderHook(() => usePrivateAttr());
    expect(result.current('Ana Brandt', 'name')).toBe('Ana xxxxxx');
    expect(result.current('Hi Ana Brandt')).toBe('Hi Ana xxxxxx');
  });
});

describe('getPrivacyDictionary under capture marks', () => {
  it('carries the marks for the length of the capture and is the shared dictionary again after', () => {
    const base = getPrivacyDictionary();
    withMarks(marks({ show: new Set(['ana']), detect: false }));
    const during = getPrivacyDictionary();
    expect([...during.show]).toEqual(['ana']);
    expect(during.detect).toBe(false);
    expect(during.tokens).toBe(base.tokens);
    expect(getPrivacyDictionary()).toBe(during); // stable while the marks are the same
    expect(base).not.toHaveProperty('show');
    withMarks(null);
    expect(getPrivacyDictionary()).toBe(base);
  });
});
