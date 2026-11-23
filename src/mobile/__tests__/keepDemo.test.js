// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { pickKeepDemo, waitForCentreOffset, openGroupAndReport, stageKeepDemo } from '../keepDemo.js';

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

describe('openGroupAndReport', () => {
  afterEach(() => { document.body.innerHTML = ''; });

  it('taps the group bubble open and logs the centre offset', async () => {
    document.body.innerHTML = '<button class="keep-bubble" data-group><span class="keep-count">3</span></button>';
    const tapped = vi.fn();
    document.querySelector('.keep-bubble').addEventListener('click', tapped);
    const log = vi.fn();
    await openGroupAndReport(log);
    expect(tapped).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith({ demo: 'keep', dx: 0, dy: 0 });
  });
});

describe('stageKeepDemo', () => {
  afterEach(() => { document.body.innerHTML = ''; });

  it('hands the staging back to the caller, so a failure in it is the caller\'s to catch', async () => {
    document.body.innerHTML = '<button class="keep-bubble" data-group><span class="keep-count">3</span></button>';
    const rows = [row(1, 'a@x'), row(2, 'b@x'), row(3, 'b@x'), row(4, 'b@x')];
    const list = { total: rows.length, rowAt: (i) => rows[i] };
    const log = vi.fn(() => { throw new Error('log broke'); });
    const staged = stageKeepDemo({ list, placeOf: () => ({ accountId: 'a1', folder: 'INBOX' }), openRow: vi.fn(), log });
    await expect(staged).rejects.toThrow('log broke');
  });
});
