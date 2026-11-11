// @vitest-environment node
// The phone's frame header reader: what the camera saw, for progress and dedupe only. The engine
// assembles and decrypts; this side must accept exactly the frames core's `parse_frame` does.
import { describe, it, expect, vi } from 'vitest';
import { parseFrameHeader, createCollector, scanUntilComplete } from '../qrFrames.js';

const frame = (id, i, n, chunk = 'QUJD') => `MVQR1:${id}:${i}/${n}:${chunk}`;

describe('parseFrameHeader', () => {
  it('reads id, index and total', () => {
    expect(parseFrameHeader(frame('0a1b2c3d', 2, 3))).toEqual({ id: '0a1b2c3d', index: 2, total: 3 });
    expect(parseFrameHeader(frame('ffffffff', 99, 99, 'a-_Z9'))).toEqual({ id: 'ffffffff', index: 99, total: 99 });
  });

  it('refuses what core refuses', () => {
    for (const text of [
      'https://example.test',
      frame('0A1B2C3D', 1, 1), // upper-case hex
      frame('0a1b2c3', 1, 1), // 7 digits
      frame('0a1b2c3d', 0, 1),
      frame('0a1b2c3d', 2, 1),
      frame('0a1b2c3d', 1, 100),
      frame('0a1b2c3d', 1, 1, ''),
      frame('0a1b2c3d', 1, 1, 'ab+/'), // not base64url
      'MVQR2:0a1b2c3d:1/1:QUJD',
      `MVQR1:0a1b2c3d:1/1:${'A'.repeat(800)}`, // longer than any frame
      null,
      42,
    ]) {
      expect(parseFrameHeader(text), String(text)).toBeNull();
    }
  });
});

describe('createCollector', () => {
  it('collects every part once, in index order', () => {
    const c = createCollector();
    expect(c.push(frame('aaaaaaaa', 2, 3, 'Ag'))).toMatchObject({ result: 'added', have: 1, total: 3, done: false });
    expect(c.push(frame('aaaaaaaa', 2, 3, 'Ag'))).toMatchObject({ result: 'repeat', have: 1, total: 3 });
    expect(c.push(frame('aaaaaaaa', 1, 3, 'AQ'))).toMatchObject({ result: 'added', have: 2 });
    expect(c.push(frame('aaaaaaaa', 3, 3, 'Aw'))).toMatchObject({ result: 'added', have: 3, total: 3, done: true });
    expect(c.frames()).toEqual([frame('aaaaaaaa', 1, 3, 'AQ'), frame('aaaaaaaa', 2, 3, 'Ag'), frame('aaaaaaaa', 3, 3, 'Aw')]);
  });

  it('starts over on a frame of another code (the desktop showed a new one)', () => {
    const c = createCollector();
    c.push(frame('aaaaaaaa', 1, 2));
    expect(c.push(frame('bbbbbbbb', 3, 3))).toMatchObject({ result: 'reset', have: 1, total: 3, done: false });
    expect(c.frames()).toEqual([frame('bbbbbbbb', 3, 3)]);
  });

  it('ignores what is not a frame and a total that disagrees', () => {
    const c = createCollector();
    expect(c.push('hello')).toMatchObject({ result: 'ignored', have: 0, total: 0, done: false });
    c.push(frame('aaaaaaaa', 1, 2));
    expect(c.push(frame('aaaaaaaa', 2, 3))).toMatchObject({ result: 'ignored', have: 1, total: 2 });
  });
});

describe('scanUntilComplete', () => {
  it('scans until every part is in, reporting progress', async () => {
    const reads = [frame('aaaaaaaa', 2, 2), 'not ours', frame('aaaaaaaa', 2, 2), frame('aaaaaaaa', 1, 2)];
    const scan = vi.fn(async () => reads.shift());
    const progress = [];
    const frames = await scanUntilComplete({ scan, onProgress: (p) => progress.push(p) });
    expect(frames).toEqual([frame('aaaaaaaa', 1, 2), frame('aaaaaaaa', 2, 2)]);
    expect(scan).toHaveBeenCalledTimes(4);
    expect(progress.map((p) => [p.have, p.total, p.foreign])).toEqual([[1, 2, false], [1, 2, true], [1, 2, false], [2, 2, false]]);
  });

  it('answers null once stopped, without another scan', async () => {
    let stop = false;
    const scan = vi.fn(async () => { stop = true; return frame('aaaaaaaa', 1, 2); });
    await expect(scanUntilComplete({ scan, stopped: () => stop })).resolves.toBeNull();
    expect(scan).toHaveBeenCalledTimes(1);
  });

  it('passes a scan failure on', async () => {
    const scan = vi.fn(async () => { throw Object.assign(new Error('x'), { code: 'CAMERA_DENIED' }); });
    await expect(scanUntilComplete({ scan })).rejects.toMatchObject({ code: 'CAMERA_DENIED' });
  });
});
