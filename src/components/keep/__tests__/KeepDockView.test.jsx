// @vitest-environment jsdom
import React from 'react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, within, fireEvent, cleanup } from '@testing-library/react';
import { KeepDockView } from '../KeepDockView';

afterEach(cleanup);

const item = (uid, subject, sender, keptAt) => ({ accountId: 'a1', mailbox: 'INBOX', uid, subject, sender, keptAt });
const SAM = { name: 'Sam Rivera', address: 'sam@x' };
const LENA = { name: 'lena Ortiz', address: 'lena@x' };
const samItems = [item(3, 'Invoice 2291', SAM, 30), item(2, 'Venue shortlist', SAM, 20), item(1, 'Quarterly plan v3', SAM, 10)];
const lenaItems = [item(4, 'Design review notes', LENA, 5)];
const stacks = [
  { key: 'sam@x', sender: SAM, items: samItems },
  { key: 'lena@x', sender: LENA, items: lenaItems },
];

function setup(props = {}) {
  const handlers = { onExpand: vi.fn(), onOpen: vi.fn(), onRemove: vi.fn(), onCloseStack: vi.fn(), onMove: vi.fn() };
  const all = { stacks, dock: { side: 'right', top: 0.4 }, expandedKey: null, ...handlers, ...props };
  const view = render(<KeepDockView {...all} />);
  return { ...handlers, ...view, props: all };
}
const bubbles = () => screen.getAllByTestId('keep-bubble');
const samBubble = () => bubbles()[0];
const lenaBubble = () => bubbles()[1];

describe('KeepDockView', () => {
  it('renders nothing with nothing kept', () => {
    setup({ stacks: [] });
    expect(screen.queryByTestId('keep-dock')).toBeNull();
  });

  it('a group is one bubble with its count in the centre, nothing behind it', () => {
    const { container } = setup();
    const rendered = screen.getAllByTestId('keep-stack');
    expect(rendered).toHaveLength(2);
    for (const stack of rendered) {
      expect(within(stack).getAllByTestId('keep-bubble')).toHaveLength(1);
      expect(stack.querySelectorAll('button.keep-bubble')).toHaveLength(1);
    }
    expect(container.querySelector('.keep-badge')).toBeNull();
    expect(samBubble().children).toHaveLength(1);
    expect(within(samBubble()).getByTestId('keep-count').textContent).toBe('3');
    expect(samBubble().hasAttribute('data-group')).toBe(true);
    expect(lenaBubble().children).toHaveLength(1);
    expect(within(lenaBubble()).getByTestId('keep-count').textContent).toBe('L');
    expect(lenaBubble().hasAttribute('data-group')).toBe(false);
    expect(samBubble().getAttribute('aria-label')).toBe('Sam Rivera, 3 kept emails');
  });

  it("the count is the bubble's centred content", () => {
    const style = document.createElement('style');
    style.textContent = readFileSync(fileURLToPath(new URL('../../../styles/keep.css', import.meta.url)), 'utf8');
    document.head.append(style);
    setup();
    const computed = getComputedStyle(samBubble());
    expect(computed.display).toBe('grid');
    expect(computed.placeItems.replace(/ center/, '') === 'center' || computed.alignItems === 'center').toBe(true);
    expect(parseFloat(computed.paddingLeft || '0')).toBe(0);
    expect(parseFloat(computed.paddingTop || '0')).toBe(0);
    style.remove();
  });

  it('clicking a group expands it with a close button', () => {
    const { onExpand, rerender, props } = setup();
    fireEvent.click(samBubble());
    expect(onExpand).toHaveBeenCalledWith('sam@x');
    rerender(<KeepDockView {...props} expandedKey="sam@x" />);
    const panel = screen.getByTestId('keep-panel');
    expect(within(panel).getAllByTestId('keep-row')).toHaveLength(3);
    expect(within(panel).getByTestId('keep-panel-close')).toBeTruthy();
  });

  it("the expanded group's close removes the group and collapses", () => {
    const { onExpand, onCloseStack, onOpen } = setup({ expandedKey: 'sam@x' });
    fireEvent.click(screen.getByTestId('keep-panel-close'));
    expect(onCloseStack).toHaveBeenCalledWith('sam@x');
    expect(onExpand).toHaveBeenCalledWith(null);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('clicking a single bubble opens its email', () => {
    const { onOpen, onRemove, onCloseStack } = setup();
    fireEvent.pointerDown(lenaBubble(), { pointerType: 'mouse' });
    fireEvent.click(lenaBubble());
    expect(onOpen).toHaveBeenCalledWith(lenaItems[0]);
    expect(onRemove).not.toHaveBeenCalled();
    expect(onCloseStack).not.toHaveBeenCalled();
  });

  it('a touch tap expands a single bubble instead of opening it', () => {
    const { onOpen, onExpand } = setup();
    fireEvent.pointerDown(lenaBubble(), { pointerType: 'touch' });
    fireEvent.click(lenaBubble());
    expect(onExpand).toHaveBeenCalledWith('lena@x');
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('tapping an expanded bubble folds it', () => {
    const { onExpand } = setup({ expandedKey: 'sam@x' });
    fireEvent.click(samBubble());
    expect(onExpand).toHaveBeenCalledWith(null);
  });

  it('hover shows the subject of every kept email in the stack', () => {
    setup();
    fireEvent.pointerEnter(samBubble(), { pointerType: 'mouse' });
    const panel = screen.getByTestId('keep-panel');
    for (const subject of ['Invoice 2291', 'Venue shortlist', 'Quarterly plan v3']) expect(panel.textContent).toContain(subject);
    fireEvent.pointerLeave(samBubble(), { pointerType: 'mouse' });
    expect(screen.queryByTestId('keep-panel')).toBeNull();
  });

  it('hover shows a single email its subject and its header close', () => {
    setup();
    fireEvent.pointerEnter(lenaBubble(), { pointerType: 'mouse' });
    expect(screen.getByTestId('keep-panel').textContent).toContain('Design review notes');
    expect(screen.getByTestId('keep-panel-close')).toBeTruthy();
  });

  it('focus shows the same panel', () => {
    setup();
    fireEvent.focus(samBubble());
    expect(within(screen.getByTestId('keep-panel')).getAllByTestId('keep-row')).toHaveLength(3);
  });

  it('a row opens that email and collapses', () => {
    const { onOpen, onExpand } = setup({ expandedKey: 'sam@x' });
    fireEvent.click(screen.getAllByTestId('keep-row')[1]);
    expect(onOpen).toHaveBeenCalledWith(samItems[1]);
    expect(onExpand).toHaveBeenCalledWith(null);
  });

  it("a row's close removes only that email", () => {
    const { onRemove, onCloseStack, onOpen } = setup({ expandedKey: 'sam@x' });
    fireEvent.click(screen.getAllByTestId('keep-row-remove')[0]);
    expect(onRemove).toHaveBeenCalledWith('a1|INBOX|3');
    expect(onCloseStack).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('Escape and an outside press collapse the expanded group without removing anything', () => {
    const { onExpand, onRemove, onCloseStack } = setup({ expandedKey: 'sam@x' });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onExpand).toHaveBeenCalledWith(null);
    onExpand.mockClear();
    fireEvent.pointerDown(document.body);
    expect(onExpand).toHaveBeenCalledWith(null);
    onExpand.mockClear();
    fireEvent.pointerDown(samBubble());
    expect(onExpand).not.toHaveBeenCalled();
    expect(onRemove).not.toHaveBeenCalled();
    expect(onCloseStack).not.toHaveBeenCalled();
  });

  it('the grip moves the dock with arrow keys', () => {
    const { onMove } = setup();
    const grip = screen.getByTestId('keep-dock-grip');
    fireEvent.keyDown(grip, { key: 'ArrowLeft' });
    expect(onMove).toHaveBeenLastCalledWith({ side: 'left', top: 0.4 });
    fireEvent.keyDown(grip, { key: 'ArrowDown' });
    expect(onMove.mock.calls.at(-1)[0].top).toBeCloseTo(0.45);
  });

  it('dragging the grip snaps the dock to the drop side', () => {
    const { onMove } = setup();
    vi.spyOn(screen.getByTestId('keep-dock'), 'getBoundingClientRect')
      .mockReturnValue({ left: 100, top: 200, width: 48, height: 120, right: 148, bottom: 320 });
    const grip = screen.getByTestId('keep-dock-grip');
    fireEvent.pointerDown(grip, { clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(grip, { clientX: -80, clientY: 30, pointerId: 1 });
    fireEvent.pointerUp(grip, { pointerId: 1 });
    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onMove.mock.calls[0][0].side).toBe('left');
  });

  it('pressing a bubble does not move the dock', () => {
    const { onMove } = setup();
    fireEvent.pointerDown(samBubble(), { pointerType: 'mouse' });
    fireEvent.click(samBubble());
    expect(onMove).not.toHaveBeenCalled();
  });
});
