// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const renderMessageToCanvas = vi.fn();
vi.mock('../../renderMessageToCanvas', () => ({ renderMessageToCanvas: (...a) => renderMessageToCanvas(...a) }));
vi.mock('../../../../utils/darkReaderInject', () => ({
  getDarkReaderInlineScripts: ({ palette, nonce }) => `<script nonce="${nonce}">DR ${palette}</script>`,
}));

const { renderSocialCard, waitForDarkReader } = await import('../renderSocialCard');

const message = { subject: 'Hi', from: 'a@b.c', date: new Date('2026-08-28T09:14:00') };
const onCloneNode = () => {};
const canvasOf = (width, height) => ({ width, height });

let drawImage;
let fillRect;
let getContext;
beforeEach(() => {
  renderMessageToCanvas.mockReset();
  renderMessageToCanvas.mockImplementation(async ({ part }) => (part === 'head' ? canvasOf(1640, 200) : canvasOf(1640, 3000)));
  drawImage = vi.fn(); fillRect = vi.fn();
  getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage, fillRect, set fillStyle(v) { this.fill = v; } });
});
afterEach(() => getContext.mockRestore());

const callFor = (part) => renderMessageToCanvas.mock.calls.map(c => c[0]).find(a => a.part === part);

describe('renderSocialCard', () => {
  it('stacks the header over the body on one canvas: widest wide, heights added', async () => {
    const out = await renderSocialCard({ message, bodyHtml: '<p>x</p>', appearance: 'light', mail: 'light' });
    expect([out.width, out.height]).toEqual([1640, 3200]);
    expect(drawImage.mock.calls.map(c => [c[1], c[2]])).toEqual([[0, 0], [0, 200]]);
    expect(fillRect).toHaveBeenCalledWith(0, 0, 1640, 200);
  });

  it('light mail: a plain frame, no scripts, no Dark Reader', async () => {
    await renderSocialCard({ message, bodyHtml: '<p>x</p>', appearance: 'light', mail: 'light' });
    const body = callFor('body');
    expect(body.sandbox).toBeUndefined();
    expect(body.extraHead).toBeUndefined();
    expect(body.beforeCapture).toBeUndefined();
    expect(body.theme).toBeUndefined();
    expect(body.bodyHtml).toBe('<p>x</p>');
    // The header block carries no body.
    expect(callFor('head').bodyHtml).toBeUndefined();
  });

  it('the header takes the Appearance theme by plain CSS: no scripts even when dark', async () => {
    await renderSocialCard({ message, bodyHtml: '<p>x</p>', appearance: 'dark', mail: 'light' });
    const head = callFor('head');
    expect(head).toMatchObject({ theme: 'dark', backgroundColor: '#1e1f22' });
    expect(head.sandbox).toBeUndefined();
    expect(head.extraHead).toBeUndefined();
    expect(callFor('body').theme).toBeUndefined(); // dark appearance over a light mail
  });

  it('dark mail: scripts allowed in that frame only, under a nonce-only CSP that admits Dark Reader', async () => {
    await renderSocialCard({ message, bodyHtml: '<p>x</p>', appearance: 'light', mail: 'dark', palette: 'graphite' });
    const body = callFor('body');
    expect(body.theme).toBe('dark');
    expect(body.sandbox).toBe('allow-same-origin allow-scripts');
    const nonce = /script-src 'nonce-([0-9a-f]+)'/.exec(body.extraHead)[1];
    expect(nonce.length).toBeGreaterThanOrEqual(16);
    expect(body.extraHead).toContain(`<script nonce="${nonce}">DR graphite</script>`);
    expect(body.extraHead.indexOf('Content-Security-Policy')).toBeLessThan(body.extraHead.indexOf('<script'));
    expect(body.backgroundColor).toBe('#121313'); // graphite dark mail ground
    expect(typeof body.beforeCapture).toBe('function');
    expect(callFor('head').sandbox).toBeUndefined();
    expect(callFor('head').theme).toBe('light');
  });

  it('a fresh nonce for every render', async () => {
    await renderSocialCard({ message, bodyHtml: '', mail: 'dark' });
    await renderSocialCard({ message, bodyHtml: '', mail: 'dark' });
    const nonces = renderMessageToCanvas.mock.calls.map(c => c[0]).filter(a => a.part === 'body')
      .map(a => /nonce-([0-9a-f]+)/.exec(a.extraHead)[1]);
    expect(new Set(nonces).size).toBe(2);
  });

  it('redacts both halves: the header holds the names and addresses', async () => {
    await renderSocialCard({ message, bodyHtml: '<p>x</p>', appearance: 'dark', mail: 'dark', redactStyle: 'blur', onCloneNode });
    for (const part of ['head', 'body']) {
      expect(callFor(part).redactStyle).toBe('blur');
      expect(callFor(part).onCloneNode).toBe(onCloneNode);
    }
  });
});

describe('waitForDarkReader', () => {
  const frames = () => { const doc = document.implementation.createHTMLDocument('x'); return doc; };

  it('returns at once when Dark Reader is already on the document, after two frames', async () => {
    const doc = frames();
    doc.documentElement.setAttribute('data-darkreader-scheme', 'dark');
    const raf = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => { cb(0); return 1; });
    await waitForDarkReader(doc, 1000);
    expect(raf).toHaveBeenCalledTimes(2);
    raf.mockRestore();
  });

  it('waits for the style Dark Reader adds, then two more frames', async () => {
    const doc = frames();
    let n = 0;
    const raf = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => {
      if (++n === 2) { const s = doc.createElement('style'); s.className = 'darkreader'; doc.head.appendChild(s); }
      cb(0); return 1;
    });
    await waitForDarkReader(doc, 1000);
    expect(n).toBe(4);
    raf.mockRestore();
  });

  it('never hangs: gives up at the bound when Dark Reader never shows', async () => {
    const started = Date.now();
    await waitForDarkReader(frames(), 120);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
