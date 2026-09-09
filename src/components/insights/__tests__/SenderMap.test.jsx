// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import SenderMap from '../SenderMap';
import SenderList from '../SenderList';
afterEach(cleanup);
const endAt = Date.parse('2026-09-09T12:00:00Z');
const senders = [
  { address: 'ana@test', name: 'Ana', count: 4, received: 3, sent: 1, lastAt: '2026-09-08T12:00:00Z', automationEvidence: [] },
  { address: 'unknown@test', name: 'Undated', count: 2, received: 2, sent: 0, lastAt: null, automationEvidence: [] },
];
describe('sender map and list', () => {
  it('selects a real sender from both map and equivalent list with counts and last date', () => {
    const onSelect = vi.fn();
    render(<SenderMap senders={senders} endAt={endAt} selectedAddress="ana@test" onSelect={onSelect} />);
    const map = screen.getByRole('group', { name: 'Sender map' });
    const node = within(map).getByRole('button', { name: /Ana.*ana@test.*4 messages.*8 September 2026/i });
    fireEvent.click(node);
    expect(onSelect).toHaveBeenCalledWith('ana@test');
    expect(node.getAttribute('aria-pressed')).toBe('true');
    const list = screen.getByRole('list', { name: 'Sender list' });
    fireEvent.click(within(list).getByRole('button', { name: /Undated.*Unknown date/i }));
    expect(onSelect).toHaveBeenLastCalledWith('unknown@test');
  });
  it('finds and brings a sender outside the top thirty into the map', () => {
    const input = Array.from({ length: 50 }, (_, i) => ({ ...senders[0], address: `person${i}@test`, name: `Person ${i}`, count: 50 - i }));
    render(<SenderMap senders={input} endAt={endAt} selectedAddress={null} onSelect={() => {}} />);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search senders' }), { target: { value: 'person49@' } });
    const map = screen.getByRole('group', { name: 'Sender map' });
    expect(within(map).getByRole('button', { name: /person49@test/i })).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Sender list' }).children).toHaveLength(1);
  });
  it('updates available senders after the shared automated filter changes', () => {
    const { rerender } = render(<SenderMap senders={senders} endAt={endAt} onSelect={() => {}} />);
    rerender(<SenderMap senders={[senders[1]]} endAt={endAt} onSelect={() => {}} />);
    expect(screen.queryByRole('button', { name: /ana@test/ })).toBeNull();
    expect(screen.getByRole('button', { name: /unknown@test.*Unknown date/ })).toBeTruthy();
  });
  it('orders a real epoch timestamp before an unknown date', () => {
    render(<SenderList senders={[
      { ...senders[1], address: 'a-unknown@test' },
      { ...senders[0], address: 'z-epoch@test', lastAt: '1970-01-01T00:00:00Z' },
    ]} onSelect={() => {}} />);
    const rows = within(screen.getByRole('list', { name: 'Sender list' })).getAllByRole('button');
    expect(rows[0].getAttribute('aria-label')).toContain('z-epoch@test');
  });
  it('sorts the complete standalone list by count or latest event without selecting', () => {
    const onSelect = vi.fn();
    render(<SenderList senders={[{ ...senders[1], count: 100 }, senders[0]]} endAt={endAt} onSelect={onSelect} />);
    const rows = () => within(screen.getByRole('list', { name: 'Sender list' })).getAllByRole('button');
    expect(rows()[0].getAttribute('aria-label')).toContain('ana@test');
    fireEvent.change(screen.getByRole('combobox', { name: 'Sort senders' }), { target: { value: 'count' } });
    expect(rows()[0].getAttribute('aria-label')).toContain('unknown@test');
    expect(onSelect).not.toHaveBeenCalled();
  });
});
