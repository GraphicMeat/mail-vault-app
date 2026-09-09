import { describe, expect, it } from 'vitest';
import { layoutSenderMap } from '../mapLayout';
const endAt = Date.parse('2026-09-09T12:00:00Z');
const options = { width: 900, height: 600, endAt };
const senders = [
  { address: 'old@test', count: 40, lastAt: '2026-06-01T12:00:00Z' },
  { address: 'new@test', count: 10, lastAt: '2026-09-09T11:00:00Z' },
];
describe('sender map geometry', () => {
  it('encodes volume by area without making the frequent older sender recent', () => {
    const { nodes } = layoutSenderMap(senders, options);
    const old = nodes.find(n => n.address === 'old@test');
    const recent = nodes.find(n => n.address === 'new@test');
    expect(old?.radius / recent?.radius).toBeCloseTo(2);
    expect(old.radialDistance).toBeGreaterThan(recent.radialDistance);
  });
  it('keeps placement stable when input order changes, including ties', () => {
    const input = Array.from({ length: 12 }, (_, i) => ({ address: `person${i}@test`, count: 10, lastAt: '2026-09-01T00:00:00Z' }));
    const layout = layoutSenderMap(input, options);
    expect(layout.nodes.length).toBeGreaterThan(1);
    expect(layoutSenderMap([...input].reverse(), options)).toEqual(layout);
  });
  it('has nonoverlapping touch targets while preserving every actual radial distance', () => {
    const input = Array.from({ length: 500 }, (_, i) => ({ address: `person${i}@test`, count: 500 - i, lastAt: '2026-09-08T12:00:00Z' }));
    const { nodes, center, omittedCount } = layoutSenderMap(input, options);
    expect(nodes.length).toBeGreaterThan(0);
    expect(nodes.length).toBeLessThanOrEqual(30);
    expect(omittedCount).toBe(500 - nodes.length);
    for (const node of nodes) {
      expect(Math.hypot(node.x - center.x, node.y - center.y)).toBeCloseTo(node.radialDistance, 8);
      expect(node.radialDistance).toBeCloseTo(nodes[0].radialDistance, 8);
      expect(node.x - Math.max(12, node.radius)).toBeGreaterThanOrEqual(0);
      expect(node.y + Math.max(12, node.radius)).toBeLessThanOrEqual(600);
    }
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
      expect(Math.hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y)).toBeGreaterThanOrEqual(Math.max(12, nodes[i].radius) + Math.max(12, nodes[j].radius));
    }
  });
  it('limits eligibility to the top thirty by count, latest time then address', () => {
    const input = Array.from({ length: 40 }, (_, i) => ({ address: String(i).padStart(2, '0') + '@test', count: 100 - i, lastAt: `2026-08-${String(1 + i % 28).padStart(2, '0')}T00:00:00Z` }));
    const { nodes } = layoutSenderMap(input, { ...options, width: 2000, height: 2000 });
    expect(nodes.length).toBeGreaterThan(0);
    expect(nodes.every(n => Number(n.address.split('@')[0]) < 30)).toBe(true);
    expect(layoutSenderMap(input, { ...options, limit: 2 }).nodes.map(n => n.address)).toEqual(['00@test', '01@test']);
  });
  it('excludes missing or invalid dates from recency and zero counts from the map', () => {
    const { nodes, omittedCount } = layoutSenderMap([...senders,
      { address: 'unknown@test', count: 900, lastAt: null },
      { address: 'invalid@test', count: 800, lastAt: 'invalid' },
      { address: 'zero@test', count: 0, lastAt: '2026-09-01T00:00:00Z' },
    ], options);
    expect(nodes.map(n => n.address)).toEqual(['old@test', 'new@test']);
    expect(omittedCount).toBe(3);
  });
});
