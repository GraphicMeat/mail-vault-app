// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

vi.mock('../../../i18n', () => ({ useT: () => (k) => k }));
vi.mock('lucide-react', () => new Proxy({}, {
  get: (_t, name) => (typeof name === 'symbol' || name === 'then' ? undefined : () => null),
  has: () => true,
}));
vi.mock('../../../utils/dateFormat', () => ({ formatDateOnly: (ms) => `D${ms}` }));
const h = vi.hoisted(() => ({ s: null, fresh: null }));
vi.mock('../../../stores/peopleStore', async () => {
  const { create } = await import('zustand');
  h.fresh = () => ({ journal: [], loadJournal: vi.fn(), undo: vi.fn() });
  h.s = create(() => h.fresh());
  return { usePeopleStore: h.s };
});
import { PersonActivity } from '../PersonActivity';

beforeEach(() => h.s.setState(h.fresh(), true));
afterEach(cleanup);

describe('PersonActivity', () => {
  it('loads the journal on mount', () => {
    render(<PersonActivity />);
    expect(h.s.getState().loadJournal).toHaveBeenCalledTimes(1);
  });

  it('lists each op with its label and date', () => {
    h.s.setState({ journal: [
      { id: 3, op: 'merge', tsMs: 30, undone: false, count: 1 },
      { id: 2, op: 'edit', tsMs: 20, undone: false, count: 1 },
      { id: 1, op: 'import', tsMs: 10, undone: false, count: 40 },
    ] });
    render(<PersonActivity />);
    expect(screen.getByTestId('activity-row-3').textContent).toContain('contacts.activity.op.merge');
    expect(screen.getByTestId('activity-row-3').textContent).toContain('D30');
    expect(screen.getByTestId('activity-row-2').textContent).toContain('contacts.activity.op.edit');
    expect(screen.getByTestId('activity-row-1').textContent).toContain('contacts.activity.op.import');
  });

  it('marks undone entries', () => {
    h.s.setState({ journal: [
      { id: 2, op: 'edit', tsMs: 20, undone: false, count: 1 },
      { id: 1, op: 'create', tsMs: 10, undone: true, count: 1 },
    ] });
    render(<PersonActivity />);
    expect(screen.getByTestId('activity-undone-1')).toBeTruthy();
    expect(screen.queryByTestId('activity-undone-2')).toBeNull();
  });

  it('Undo calls undo while an entry can still be undone', () => {
    h.s.setState({ journal: [{ id: 1, op: 'edit', tsMs: 10, undone: false, count: 1 }] });
    render(<PersonActivity />);
    expect(screen.getByTestId('activity-undo').disabled).toBe(false);
    fireEvent.click(screen.getByTestId('activity-undo'));
    expect(h.s.getState().undo).toHaveBeenCalledTimes(1);
  });

  it('Undo is disabled when every entry is already undone', () => {
    h.s.setState({ journal: [{ id: 1, op: 'edit', tsMs: 10, undone: true, count: 1 }] });
    render(<PersonActivity />);
    expect(screen.getByTestId('activity-undo').disabled).toBe(true);
  });

  it('an empty journal shows the empty text and a disabled Undo', () => {
    render(<PersonActivity />);
    expect(screen.getByText('contacts.activity.empty')).toBeTruthy();
    expect(screen.getByTestId('activity-undo').disabled).toBe(true);
  });
});
