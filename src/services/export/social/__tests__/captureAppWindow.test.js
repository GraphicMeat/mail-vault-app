// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
let lastClone = null;
let lastOpts = null;
let maskDuringCapture = null;
vi.mock('modern-screenshot', () => ({
  domToCanvas: vi.fn(async (node, opts) => {
    const { usePrivacyStore: store } = await import('../../../../stores/privacyStore');
    maskDuringCapture = store.getState().captureMask;
    const clone = node.cloneNode(true);
    await opts.onCloneNode?.(clone);
    lastClone = clone;
    lastOpts = opts;
    return Object.assign(document.createElement('canvas'), { width: 10, height: 10 });
  }),
}));
import { captureAppWindow } from '../captureAppWindow';
import { buildNameDictionary } from '../../../../utils/privacy/piiDetector';
import { usePrivacyStore } from '../../../../stores/privacyStore';
import { NEEDLES } from '../../../../test/privacyFixtures';

afterEach(() => { document.body.innerHTML = ''; lastClone = null; lastOpts = null; maskDuringCapture = null; });

describe('captureAppWindow', () => {
  it('redacts every text node and attribute of the clone, and restores capture mask after', async () => {
    document.body.innerHTML = '<div id="root"><span title="Joanna Kowalczyk">Joanna Kowalczyk</span> joanna.k@example.org</div>';
    await captureAppWindow({ redact: true, dict: buildNameDictionary({ names: ['Joanna Kowalczyk'] }) });
    expect(lastClone.outerHTML).not.toMatch(/Joanna|Kowalczyk|joanna\.k@/);
    expect(maskDuringCapture).toBe(true);
    expect(usePrivacyStore.getState().captureMask).toBe(false);
  });

  it('without redact, leaves the clone alone', async () => {
    document.body.innerHTML = '<div id="root">Joanna Kowalczyk</div>';
    await captureAppWindow({ redact: false, dict: null });
    expect(lastClone.textContent).toContain('Joanna Kowalczyk');
    expect(maskDuringCapture).toBe(false);
  });

  it('drops a frame srcdoc (the raw body) from the clone, redacted or not', async () => {
    document.body.innerHTML = '<div id="root"><iframe srcdoc="<p>Joanna Kowalczyk +370 612 34567</p>"></iframe></div>';
    await captureAppWindow({ redact: false, dict: null });
    expect(lastClone.querySelector('iframe').hasAttribute('srcdoc')).toBe(false);
    const html = lastClone.outerHTML;
    NEEDLES.forEach(n => expect(html, n).not.toContain(n));
  });

  it('leaves out whatever is marked data-capture-exclude', async () => {
    document.body.innerHTML = '<div id="root"><div data-capture-exclude=""><p>x</p></div><p id="kept">y</p></div>';
    await captureAppWindow({ redact: false, dict: null });
    const [excluded, inner, kept] = ['[data-capture-exclude]', '[data-capture-exclude] p', '#kept'].map(s => document.querySelector(s));
    expect(lastOpts.filter(excluded)).toBe(false);
    expect(lastOpts.filter(inner)).toBe(false);
    expect(lastOpts.filter(kept)).toBe(true);
    expect(lastOpts.filter(kept.firstChild)).toBe(true); // a text node
  });

  it('restores the capture mask when the capture throws', async () => {
    const { domToCanvas } = await import('modern-screenshot');
    domToCanvas.mockRejectedValueOnce(new Error('boom'));
    document.body.innerHTML = '<div id="root">a</div>';
    await expect(captureAppWindow({ redact: true, dict: buildNameDictionary({ names: [] }) })).rejects.toThrow('boom');
    expect(usePrivacyStore.getState().captureMask).toBe(false);
  });
});
