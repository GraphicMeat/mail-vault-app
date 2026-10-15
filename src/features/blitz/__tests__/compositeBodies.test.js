// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { compositeBlitzBodies } from '../surfaces/compositeBodies';
import { usePrivacyStore } from '../../../stores/privacyStore';

const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });
function body({ doc = 4, busy = false, masked = false, at = rect(10, 20, 300, 200), withDoc = !busy } = {}) {
  const el = document.createElement('div');
  el.setAttribute('data-renderer', 'blitz');
  el.setAttribute('aria-busy', String(busy));
  el.setAttribute('data-blitz-masked', String(masked));
  if (withDoc) el.setAttribute('data-blitz-doc', String(doc));
  const tiles = document.createElement('div');
  tiles.setAttribute('data-blitz-tiles', '');
  tiles.setAttribute('data-capture-exclude', '');
  tiles.getBoundingClientRect = () => at;
  el.appendChild(tiles);
  return el;
}
function setup(children) {
  const root = document.createElement('div');
  root.id = 'root';
  root.getBoundingClientRect = () => rect(0, 0, 1000, 800);
  children.forEach(c => root.appendChild(c));
  document.body.appendChild(root);
  const ctx = { save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), rect: vi.fn(), clip: vi.fn(), drawImage: vi.fn() };
  const canvas = { getContext: () => ctx };
  const deps = { imageRender: vi.fn(async () => ({ png: 'x' })), decode: vi.fn(async () => ({ width: 600, height: 400 })) };
  return { root, ctx, canvas, deps };
}
const run = (s, opts = { scale: 2, redact: false }) => compositeBlitzBodies(s.canvas, s.root, opts, s.deps);

afterEach(() => {
  document.body.innerHTML = '';
  usePrivacyStore.setState({ enabled: false, peek: false, captureMask: false });
});

describe('compositeBlitzBodies', () => {
  it('draws a settled body over its tile rect at the capture scale', async () => {
    const s = setup([body()]);
    expect(await run(s)).toBe(1);
    expect(s.deps.imageRender).toHaveBeenCalledWith(4);
    expect(s.ctx.drawImage).toHaveBeenCalledWith({ width: 600, height: 400 }, 20, 40, 600, 400);
    expect(s.ctx.clip).toHaveBeenCalledTimes(1);
  });

  it('never draws a busy body (its doc is not the current one), masked or not', async () => {
    for (const redact of [false, true]) {
      // The hold box: busy, no doc, and data-blitz-masked="true" even with privacy off.
      const s = setup([body({ busy: true, masked: true }), body({ busy: true, masked: false })]);
      expect(await run(s, { scale: 2, redact })).toBe(0);
      expect(s.deps.imageRender).not.toHaveBeenCalled();
      expect(s.ctx.drawImage).not.toHaveBeenCalled();
      s.root.remove();
    }
  });

  it('never draws a busy body even when a stale doc id is still on it', async () => {
    const s = setup([body({ busy: true, masked: true, withDoc: true })]);
    expect(await run(s, { scale: 2, redact: true })).toBe(0);
    expect(s.deps.imageRender).not.toHaveBeenCalled();
  });

  it('skips a settled body that has no doc (closed gate, failure view)', async () => {
    const s = setup([body({ withDoc: false })]);
    expect(await run(s)).toBe(0);
    expect(s.deps.imageRender).not.toHaveBeenCalled();
  });

  it('a redacted capture skips any body not rendered masked (fail closed)', async () => {
    const s = setup([body({ masked: false }), body({ doc: 5, masked: true })]);
    expect(await run(s, { scale: 2, redact: true })).toBe(1);
    expect(s.deps.imageRender).toHaveBeenCalledTimes(1);
    expect(s.deps.imageRender).toHaveBeenCalledWith(5);
  });

  it('a capture that is not redacted draws an unmasked body while privacy is off', async () => {
    const s = setup([body({ masked: false }), body({ doc: 5, masked: true })]);
    expect(await run(s)).toBe(2);
  });

  it('privacy masking on skips an unmasked body even for a capture that is not redacted', async () => {
    usePrivacyStore.setState({ enabled: true, peek: false });
    const s = setup([body({ masked: false }), body({ doc: 5, masked: true })]);
    expect(await run(s)).toBe(1);
    expect(s.deps.imageRender).toHaveBeenCalledWith(5);
  });

  it('a peek lifts privacy masking, so an unmasked body is drawn', async () => {
    usePrivacyStore.setState({ enabled: true, peek: true });
    const s = setup([body({ masked: false })]);
    expect(await run(s)).toBe(1);
  });

  it('the capture mask alone also skips an unmasked body', async () => {
    usePrivacyStore.setState({ captureMask: true });
    const s = setup([body({ masked: false })]);
    expect(await run(s)).toBe(0);
    expect(s.deps.imageRender).not.toHaveBeenCalled();
  });

  it('skips bodies inside an excluded region (the export dialog)', async () => {
    const wrap = document.createElement('div');
    wrap.setAttribute('data-capture-exclude', '');
    wrap.appendChild(body());
    const s = setup([wrap]);
    expect(await run(s)).toBe(0);
    expect(s.deps.imageRender).not.toHaveBeenCalled();
  });

  it('skips a body that is off screen', async () => {
    const s = setup([body({ at: rect(2000, 2000, 300, 200) })]);
    expect(await run(s)).toBe(0);
    expect(s.deps.imageRender).not.toHaveBeenCalled();
  });

  it('clips the draw to the visible part inside a scrolling ancestor', async () => {
    const box = document.createElement('div');
    box.style.overflowX = 'auto'; // jsdom does not expand the overflow shorthand
    box.style.overflowY = 'auto';
    box.getBoundingClientRect = () => rect(0, 0, 100, 50);
    box.appendChild(body({ at: rect(0, 0, 300, 200) }));
    const s = setup([box]);
    expect(await run(s)).toBe(1);
    expect(s.ctx.rect).toHaveBeenCalledWith(0, 0, 200, 100);
    expect(s.ctx.drawImage).toHaveBeenCalledWith({ width: 600, height: 400 }, 0, 0, 600, 400);
  });

  it('skips a body whose doc the worker lost and keeps going; closes nothing', async () => {
    const s = setup([body({ doc: 3 }), body({ doc: 6 })]);
    s.deps.imageRender = vi.fn(async (id) => { if (id === 3) throw new Error('render_unknown_doc'); return { png: 'x' }; });
    s.deps.closeRender = vi.fn();
    expect(await run(s)).toBe(1);
    expect(s.deps.imageRender).toHaveBeenCalledTimes(2);
    expect(s.ctx.drawImage).toHaveBeenCalledTimes(1);
    expect(s.deps.closeRender).not.toHaveBeenCalled();
  });

  it('skips a body whose PNG does not decode', async () => {
    const s = setup([body()]);
    s.deps.decode = vi.fn(async () => { throw new Error('bad png'); });
    expect(await run(s)).toBe(0);
    expect(s.ctx.drawImage).not.toHaveBeenCalled();
  });

  it('does not draw a body that turned busy or changed doc while its image rendered', async () => {
    const a = body({ doc: 4 });
    const b = body({ doc: 5 });
    const c = body({ doc: 6 });
    const s = setup([a, b, c]);
    s.deps.imageRender = vi.fn(async (id) => {
      if (id === 4) a.setAttribute('aria-busy', 'true');
      if (id === 5) b.setAttribute('data-blitz-doc', '9');
      return { png: 'x' };
    });
    expect(await run(s)).toBe(1);
    expect(s.ctx.drawImage).toHaveBeenCalledTimes(1);
  });

  it('does not draw a body that lost its mask while its image rendered, under a mask', async () => {
    const a = body({ doc: 4, masked: true });
    const s = setup([a]);
    s.deps.imageRender = vi.fn(async () => { a.setAttribute('data-blitz-masked', 'false'); return { png: 'x' }; });
    expect(await run(s, { scale: 2, redact: true })).toBe(0);
  });

  it('draws nothing and touches no context when there is no Blitz body', async () => {
    const s = setup([]);
    s.canvas.getContext = vi.fn();
    expect(await run(s)).toBe(0);
    expect(s.canvas.getContext).not.toHaveBeenCalled();
  });
});
