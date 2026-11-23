import { describe, it, expect } from 'vitest';
import { pickKeepDemo } from '../keepDemo.js';

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
