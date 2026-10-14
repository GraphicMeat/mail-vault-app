import { describe, it, expect } from 'vitest';
import { BORDER_WIDTH_FIELDS, parseCssColor, parsePx, parseWeight, clusterLineCount, compareElements, compareFixture, isApproved, isValidKnownDiff, matchKnownDiff } from '../compare';

const el = (over = {}) => ({
  mvId: 'p[1]', tag: 'p', rendered: true, rect: { x: 0, y: 0, w: 100, h: 20 },
  color: 'rgb(51, 51, 51)', backgroundColor: 'rgba(0, 0, 0, 0)',
  borderTopColor: 'rgb(51, 51, 51)', borderRightColor: 'rgb(51, 51, 51)',
  borderBottomColor: 'rgb(51, 51, 51)', borderLeftColor: 'rgb(51, 51, 51)',
  fontSize: '14px', fontWeight: '400', fontFamily: 'sans-serif', lineCount: 1, ...over,
});
const blitz = (over = {}) => ({
  ...el(), color: [51, 51, 51, 1], backgroundColor: [0, 0, 0, 0],
  borderTopColor: [51, 51, 51, 1], borderRightColor: [51, 51, 51, 1],
  borderBottomColor: [51, 51, 51, 1], borderLeftColor: [51, 51, 51, 1],
  fontSize: 14, fontWeight: 400, ...over,
});

describe('normalisers', () => {
  it('parses computed colour strings and arrays', () => {
    expect(parseCssColor('rgb(1, 2, 3)')).toEqual([1, 2, 3, 1]);
    expect(parseCssColor('rgba(1, 2, 3, 0.5)')).toEqual([1, 2, 3, 0.5]);
    expect(parseCssColor('transparent')).toEqual([0, 0, 0, 0]);
    expect(parseCssColor([1, 2, 3, 1])).toEqual([1, 2, 3, 1]);
    expect(parseCssColor('color(display-p3 1 0 0)')).toBeNull();
  });
  it('parses px and weights', () => {
    expect(parsePx('18.6667px')).toBeCloseTo(18.6667);
    expect(parseWeight('bold')).toBe(700);
    expect(parseWeight('600')).toBe(600);
  });
  it('clusters line rects by vertical midpoint, like the Rust side', () => {
    expect(clusterLineCount([{ top: 0, bottom: 20 }, { top: 2, bottom: 18 }, { top: 20, bottom: 40 }, { top: 41, bottom: 60 }])).toBe(3);
  });
});

describe('compareElements', () => {
  it('passes identical elements', () => {
    expect(compareElements([el()], [blitz()]).diffs).toEqual([]);
  });
  it('allows ±1 per colour channel, not ±2', () => {
    expect(compareElements([el()], [blitz({ color: [52, 50, 51, 1] })]).diffs).toEqual([]);
    expect(compareElements([el()], [blitz({ color: [53, 51, 51, 1] })]).diffs.map((d) => d.field)).toEqual(['color']);
  });
  it('allows ±1 on x and w, ±2 on y and h', () => {
    expect(compareElements([el()], [blitz({ rect: { x: 1, y: 2, w: 101, h: 22 } })]).diffs).toEqual([]);
    expect(compareElements([el()], [blitz({ rect: { x: 2, y: 3, w: 100, h: 20 } })]).diffs.map((d) => d.field)).toEqual(['x', 'y']);
  });
  it('compares the four border widths within half a pixel', () => {
    const widths = (v) => Object.fromEntries(BORDER_WIDTH_FIELDS.map((f) => [f, v]));
    const iframeSide = el(widths('1px'));
    expect(compareElements([iframeSide], [blitz(widths(1))]).diffs).toEqual([]);
    expect(compareElements([iframeSide], [blitz(widths(1.4))]).diffs).toEqual([]);
    expect(compareElements([iframeSide], [blitz({ ...widths(1), borderLeftWidth: 0 })]).diffs.map((d) => [d.field, d.iframe, d.blitz])).toEqual([['borderLeftWidth', 1, 0]]);
    expect(compareElements([iframeSide], [blitz(widths(1.6))]).diffs.map((d) => d.field)).toEqual(BORDER_WIDTH_FIELDS);
  });
  it('flags a border width one side lacks, but skips elements that carry none', () => {
    expect(compareElements([el({ borderTopWidth: '2px' })], [blitz()]).diffs.map((d) => d.field)).toEqual(['borderTopWidth']);
    expect(compareElements([el()], [blitz()]).diffs).toEqual([]);
  });
  it('requires equal font size, weight and line count', () => {
    const d = compareElements([el()], [blitz({ fontSize: 15, fontWeight: 700, lineCount: 2 })]).diffs.map((x) => x.field);
    expect(d).toEqual(['fontSize', 'fontWeight', 'lineCount']);
  });
  it('skips the rest when both sides agree an element is not rendered', () => {
    const hidden = { rendered: false, rect: null, color: null, lineCount: null };
    expect(compareElements([el(hidden)], [blitz({ ...hidden, fontSize: null })]).diffs).toEqual([]);
    expect(compareElements([el(hidden)], [blitz()]).diffs.map((d) => d.field)).toEqual(['rendered']);
  });
  it('treats an empty inline (zero-width in WebKit, no rect in Blitz) as equal', () => {
    expect(compareElements([el({ rect: { x: 5, y: 9, w: 0, h: 17 } })], [blitz({ rect: null })]).diffs).toEqual([]);
    expect(compareElements([el({ rect: { x: 5, y: 9, w: 30, h: 17 } })], [blitz({ rect: null })]).diffs.map((d) => d.field)).toEqual(['x', 'y', 'w', 'h']);
  });
  it('reports ids present on one side only', () => {
    const { diffs } = compareElements([el()], [blitz({ mvId: 'p[2]' })]);
    expect(diffs.map((d) => [d.mvId, d.field, d.blitz])).toEqual([['p[1]', 'presence', 'missing'], ['p[2]', 'presence', 'present']]);
  });
});

describe('known diffs', () => {
  const entry = { fixture: 'ours/x', mode: 'dark', width: '*', mvId: 'p[1]', field: 'color', reason: 'canvas parse', approvedBy: 'Rokas', approvedOn: '2026-10-20' };
  it('only approved entries count', () => {
    expect(isApproved(entry)).toBe(true);
    expect(isApproved({ ...entry, approvedBy: '' })).toBe(false);
    expect(isApproved({ ...entry, reason: ' ' })).toBe(false);
  });
  it('an approved entry moves a diff from failing to known', () => {
    const r = compareFixture({ fixture: 'ours/x', mode: 'dark', width: 'wide', iframe: [el()], blitz: [blitz({ color: [9, 9, 9, 1] })], knownDiffs: { version: 1, entries: [entry] } });
    expect(r.passed).toBe(true);
    expect(r.known.map((d) => d.known)).toEqual(['canvas parse']);
    const r2 = compareFixture({ fixture: 'ours/x', mode: 'light', width: 'wide', iframe: [el()], blitz: [blitz({ color: [9, 9, 9, 1] })], knownDiffs: { version: 1, entries: [entry] } });
    expect(r2.passed).toBe(false);
  });
  it('an entry that wildcards both the element and the field is invalid and matches nothing', () => {
    const all = { ...entry, mvId: '*', field: '*' };
    expect(isValidKnownDiff(all)).toBe(false);
    expect(matchKnownDiff({ version: 1, entries: [all] }, { fixture: 'ours/x', mode: 'dark', width: 'wide', mvId: 'p[1]', field: 'color' })).toBe(null);
    expect(isValidKnownDiff({ ...entry, mvId: '*' })).toBe(true);
    expect(isValidKnownDiff({ ...entry, field: '*' })).toBe(true);
  });
  it('an entry needs a parity id path (or *) as mvId', () => {
    expect(isValidKnownDiff(entry)).toBe(true);
    expect(isValidKnownDiff({ ...entry, mvId: 'table[1]/tr[2]/td[1]' })).toBe(true);
    // localName keeps the HTML parser's SVG case (linearGradient, clipPath, foreignObject).
    expect(isValidKnownDiff({ ...entry, mvId: 'svg[1]/defs[1]/linearGradient[1]' })).toBe(true);
    for (const mvId of [undefined, '', 'p1', 'p[1]/', ' p[1]', 'p[0]']) expect(isValidKnownDiff({ ...entry, mvId })).toBe(false);
  });
});

describe('compareFixture', () => {
  it('never passes a case that compared nothing', () => {
    const r = compareFixture({ fixture: 'ours/x', mode: 'light', width: 'wide', iframe: [], blitz: [], knownDiffs: { version: 1, entries: [] } });
    expect(r.compared).toBe(0);
    expect(r.passed).toBe(false);
  });
});
