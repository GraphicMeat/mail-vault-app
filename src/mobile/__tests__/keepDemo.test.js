// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { pickKeepDemo, waitForCentreOffset } from '../keepDemo.js';

const row = (uid, fromAddress) => ({ uid, fromAddress, fromName: '' });

describe('pickKeepDemo', () => {
  it('gives null when no sender repeats', () => {
    expect(pickKeepDemo([row(1, 'a@x'), row(2, 'b@x'), row(3, 'c@x')])).toBeNull();
  });

  it("picks the first repeated sender's first three rows and one other sender's row", () => {
    const rows = [row(1, 'a@x'), row(2, 'b@x'), row(3, 'B@x'), row(4, 'b@x'), row(5, 'b@x'), row(6, 'c@x')];
    const picked = pickKeepDemo(rows);
    expect(picked.group.map((r) => r.uid)).toEqual([2, 3, 4]);
    expect(picked.other.uid).toBe(1);
  });

  it('gives null when every row is one sender', () => {
    expect(pickKeepDemo([row(1, 'a@x'), row(2, 'a@x')])).toBeNull();
  });
});

describe('waitForCentreOffset', () => {
  afterEach(() => { document.body.innerHTML = ''; });

  it('waits for a group bubble that is laid out late', async () => {
    const pending = waitForCentreOffset({ timeout: 500, interval: 5 });
    setTimeout(() => { document.body.innerHTML = '<button class="keep-bubble" data-group><span class="keep-count">3</span></button>'; }, 30);
    expect(await pending).toEqual({ dx: 0, dy: 0 });
  });

  it('gives null when no group bubble ever shows', async () => {
    expect(await waitForCentreOffset({ timeout: 30, interval: 5 })).toBeNull();
  });
});
