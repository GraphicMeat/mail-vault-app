import { describe, it, expect } from 'vitest';
import { wantsProgressUi, buildFinished, progressPercent, BIG_BACKLOG } from '../searchIndexProgress.js';

const s = (o) => ({ available: true, state: 'indexing', indexed: 0, total: 0, complete: false, firstPassDone: false, ...o });

describe('search index progress rule', () => {
  it('shows a first build that has work left', () => {
    expect(wantsProgressUi(s({ indexed: 10, total: 40 }))).toBe(true);
  });
  it('never shows a pass with nothing to parse (an empty or already-built vault)', () => {
    expect(wantsProgressUi(s({ indexed: 0, total: 0 }))).toBe(false);
    expect(wantsProgressUi(s({ indexed: 40, total: 40 }))).toBe(false);
  });
  it('after the first pass, only a backlog of 500 or more', () => {
    expect(wantsProgressUi(s({ firstPassDone: true, indexed: 1000, total: 1000 + BIG_BACKLOG - 1 }))).toBe(false);
    expect(wantsProgressUi(s({ firstPassDone: true, indexed: 1000, total: 1000 + BIG_BACKLOG }))).toBe(true);
  });
  it('only while indexing and not complete', () => {
    for (const state of ['idle', 'unavailable', 'off']) expect(wantsProgressUi(s({ state, indexed: 1, total: 900 }))).toBe(false);
    expect(wantsProgressUi(s({ indexed: 1, total: 900, complete: true }))).toBe(false);
    expect(wantsProgressUi(null)).toBe(false);
  });
  it('a build is finished only once the first pass is done, and complete or a small backlog', () => {
    // review 1.10 I1: `complete` alone can be a folder boundary mid-build
    // (indexed === total for that folder, firstPassDone still false) — must
    // not count as finished on its own.
    expect(buildFinished(s({ complete: true, firstPassDone: false }))).toBe(false);
    expect(buildFinished(s({ complete: true, firstPassDone: true }))).toBe(true);
    expect(buildFinished(s({ firstPassDone: true, indexed: 10, total: 12 }))).toBe(true);
    expect(buildFinished(s({ firstPassDone: false, indexed: 10, total: 12 }))).toBe(false);
    expect(buildFinished(s({ state: 'idle', firstPassDone: false, indexed: 500, total: 3000 }))).toBe(false);
  });
  it('percent is floored and capped', () => {
    expect(progressPercent(s({ indexed: 1, total: 3 }))).toBe(33);
    expect(progressPercent(s({ indexed: 5, total: 4 }))).toBe(100);
    expect(progressPercent(s({ total: 0 }))).toBe(0);
  });
});
