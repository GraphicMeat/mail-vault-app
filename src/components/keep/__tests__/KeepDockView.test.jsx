// @vitest-environment jsdom
import React, { useState } from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, within, fireEvent, cleanup } from '@testing-library/react';
import { KeepDockView } from '../KeepDockView';
import { SettingsViewProvider } from '../../settings/views/viewContext';

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

// The app side of the view: it holds the expanded key as the real containers do.
function Host({ initial = null, ...props }) {
  const [expandedKey, setExpandedKey] = useState(initial);
  return <KeepDockView {...props} stacks={props.stacks ?? stacks} dock={{ side: 'right', top: 0.4 }}
    expandedKey={expandedKey} onExpand={setExpandedKey} />;
}
const hostHandlers = () => ({ onOpen: vi.fn(), onRemove: vi.fn(), onCloseStack: vi.fn(), onMove: vi.fn() });
// What a real mouse press on a bubble does: pointerdown, then focus, then click.
const press = bubble => { fireEvent.pointerDown(bubble, { pointerType: 'mouse' }); fireEvent.focus(bubble); fireEvent.click(bubble); };

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

  it('only a bubble that expands says whether it is expanded', () => {
    setup();
    expect(samBubble().getAttribute('aria-expanded')).toBe('false');
    expect(lenaBubble().hasAttribute('aria-expanded')).toBe(false);
  });

  it("the count is the bubble's centred content", () => {
    const style = document.createElement('style');
    style.textContent = readFileSync(resolve(process.cwd(), 'src/styles/keep.css'), 'utf8');
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

  it('Escape puts away the panel a keyboard focus peeked', () => {
    setup();
    fireEvent.focus(samBubble());
    expect(screen.getByTestId('keep-panel')).toBeTruthy();
    fireEvent.keyDown(samBubble(), { key: 'Escape' });
    expect(screen.queryByTestId('keep-panel')).toBeNull();
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

  it("Escape that folds an open group does not reach the app's own Escape shortcut", () => {
    const appEscape = vi.fn();
    window.addEventListener('keydown', appEscape);
    setup({ expandedKey: 'sam@x' });
    const notCancelled = fireEvent.keyDown(document.body, { key: 'Escape' });
    window.removeEventListener('keydown', appEscape);
    expect(notCancelled).toBe(false);
    expect(appEscape).not.toHaveBeenCalled();
  });

  it("Escape that puts away a focus peek does not reach the app's own Escape shortcut", () => {
    const appEscape = vi.fn();
    window.addEventListener('keydown', appEscape);
    setup();
    fireEvent.focus(samBubble());
    const notCancelled = fireEvent.keyDown(samBubble(), { key: 'Escape' });
    window.removeEventListener('keydown', appEscape);
    expect(notCancelled).toBe(false);
    expect(appEscape).not.toHaveBeenCalled();
  });

  it('Escape puts away a hover peek that sits on an expanded group', () => {
    const { onExpand, rerender, props } = setup({ expandedKey: 'sam@x' });
    fireEvent.pointerEnter(samBubble(), { pointerType: 'mouse' });
    fireEvent.keyDown(samBubble(), { key: 'Escape' });
    expect(onExpand).toHaveBeenCalledWith(null);
    rerender(<KeepDockView {...props} expandedKey={null} />);
    expect(screen.queryByTestId('keep-panel')).toBeNull();
  });

  it("Escape in another layer's field is left to that layer", () => {
    const { onExpand } = setup({ expandedKey: 'sam@x' });
    const field = document.body.appendChild(document.createElement('input'));
    const notCancelled = fireEvent.keyDown(field, { key: 'Escape' });
    field.remove();
    expect(notCancelled).toBe(true);
    expect(onExpand).not.toHaveBeenCalled();
  });

  it('Escape with no panel showing is left to the app', () => {
    const appEscape = vi.fn();
    window.addEventListener('keydown', appEscape);
    setup();
    const notCancelled = fireEvent.keyDown(samBubble(), { key: 'Escape' });
    window.removeEventListener('keydown', appEscape);
    expect(notCancelled).toBe(true);
    expect(appEscape).toHaveBeenCalledTimes(1);
  });

  it('the panel stays while the pointer crosses from the bubble onto it', () => {
    setup();
    fireEvent.pointerEnter(lenaBubble(), { pointerType: 'mouse' });
    const panel = screen.getByTestId('keep-panel');
    fireEvent.pointerLeave(lenaBubble(), { pointerType: 'mouse', relatedTarget: panel });
    fireEvent.pointerEnter(panel, { pointerType: 'mouse' });
    expect(screen.getByTestId('keep-panel')).toBeTruthy();
  });

  it("the gap between a bubble and its panel counts as the panel, and only the rows scroll", () => {
    const css = readFileSync(resolve(process.cwd(), 'src/styles/keep.css'), 'utf8');
    expect(css).toMatch(/\.keep-panel::before\s*\{[^}]*position:\s*absolute/);
    const panelRule = css.match(/\n\.keep-panel\s*\{[^}]*\}/)[0];
    expect(panelRule).not.toMatch(/overflow/);
    // A later column's bubbles must not paint over an earlier stack's open panel.
    expect(panelRule).toMatch(/z-index:\s*[1-9]/);
    expect(css.match(/\n\.keep-rows\s*\{[^}]*\}/)[0]).toMatch(/overflow-y:\s*auto/);
  });

  it('a hover does not open a second panel over an expanded group', () => {
    setup({ expandedKey: 'sam@x' });
    fireEvent.pointerEnter(lenaBubble(), { pointerType: 'mouse' });
    expect(screen.getAllByTestId('keep-panel')).toHaveLength(1);
  });

  it('the dock is bounded to the screen below it and wraps into columns', () => {
    setup({ dock: { side: 'right', top: 0.4 } });
    // The same inset the CSS top uses, so a phone's status bar does not push the dock past the bottom clearance.
    expect(screen.getByTestId('keep-dock').style.maxHeight).toContain('max(var(--keep-top), var(--keep-top-inset, 0px))');
    const css = readFileSync(resolve(process.cwd(), 'src/styles/keep.css'), 'utf8');
    expect(css.match(/\n\.keep-dock\s*\{[^}]*\}/)[0]).toMatch(/flex-wrap:\s*wrap/);
  });

  it('a panel with no room below its bubble opens upward', () => {
    const rects = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function rect() {
      if (this.classList.contains('keep-panel')) return { top: 600, bottom: 900, height: 300, left: 0, right: 200, width: 200 };
      if (this.classList.contains('keep-stack')) return { top: 600, bottom: 644, height: 44, left: 0, right: 44, width: 44 };
      return { top: 0, bottom: 0, height: 0, left: 0, right: 0, width: 0 };
    });
    setup({ expandedKey: 'lena@x' });
    expect(screen.getByTestId('keep-panel').hasAttribute('data-flip')).toBe(true);
    rects.mockRestore();
  });

  it('the panel is measured again when the dock moves', () => {
    let stackTop = 100;
    const rects = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function rect() {
      if (this.classList.contains('keep-panel')) return { top: 0, bottom: 300, height: 300, left: 0, right: 200, width: 200 };
      if (this.classList.contains('keep-stack')) return { top: stackTop, bottom: stackTop + 44, height: 44, left: 0, right: 44, width: 44 };
      return { top: 0, bottom: 0, height: 0, left: 0, right: 0, width: 0 };
    });
    const { rerender, props } = setup({ expandedKey: 'lena@x' });
    expect(screen.getByTestId('keep-panel').hasAttribute('data-flip')).toBe(false);
    stackTop = 600;
    rerender(<KeepDockView {...props} dock={{ side: 'right', top: 0.8 }} />);
    expect(screen.getByTestId('keep-panel').hasAttribute('data-flip')).toBe(true);
    rects.mockRestore();
  });

  it('the dock top stays below the phone status bar through a CSS inset', () => {
    setup();
    expect(screen.getByTestId('keep-dock').style.getPropertyValue('--keep-top')).toBe('40vh');
    const css = readFileSync(resolve(process.cwd(), 'src/styles/keep.css'), 'utf8');
    expect(css.match(/\n\.keep-dock\s*\{[^}]*\}/)[0]).toMatch(/top:\s*max\(var\(--keep-top\),\s*var\(--keep-top-inset,\s*0px\)\)/);
    const phone = readFileSync(resolve(process.cwd(), 'src/mobile/mobile.css'), 'utf8');
    expect(phone).toMatch(/\.mv-app \.keep-dock\s*\{[^}]*--keep-top-inset:\s*var\(--mv-safe-top\)/);
  });

  it('the grip moves the dock with arrow keys', () => {
    const { onMove } = setup();
    const grip = screen.getByTestId('keep-dock-grip');
    fireEvent.keyDown(grip, { key: 'ArrowLeft' });
    expect(onMove).toHaveBeenLastCalledWith({ side: 'left', top: 0.4 });
    fireEvent.keyDown(grip, { key: 'ArrowDown' });
    expect(onMove.mock.calls.at(-1)[0].top).toBeCloseTo(0.45);
  });

  it('the arrow keys keep the dock above the bottom bar', () => {
    const { onMove } = setup({ dock: { side: 'right', top: 0.8 } });
    const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect')
      .mockReturnValue({ top: 640, bottom: 706, height: 66, left: 0, right: 44, width: 44 });
    fireEvent.keyDown(screen.getByTestId('keep-dock-grip'), { key: 'ArrowDown' });
    rect.mockRestore();
    expect(onMove.mock.calls.at(-1)[0].top).toBeCloseTo((window.innerHeight - 66 - 72) / window.innerHeight);
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

  it('a mouse press on a bubble opens and folds its panel, and the focus it takes does not peek it back open', () => {
    render(<Host {...hostHandlers()} />);
    press(samBubble());
    expect(screen.getByTestId('keep-panel')).toBeTruthy();
    press(samBubble());
    expect(screen.queryByTestId('keep-panel')).toBeNull();
  });

  it('a click folds a group the pointer is resting on', () => {
    render(<Host {...hostHandlers()} />);
    fireEvent.pointerEnter(samBubble().parentElement, { pointerType: 'mouse' });
    press(samBubble());
    expect(samBubble().getAttribute('aria-expanded')).toBe('true');
    press(samBubble());
    expect(samBubble().getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('keep-panel')).toBeNull();
  });

  it("the bubble's label goes through the app's privacy mask", () => {
    const mask = (value, kind) => (kind === 'name' ? '****' : value);
    render(<SettingsViewProvider privateAttr={mask}><Host {...hostHandlers()} /></SettingsViewProvider>);
    expect(samBubble().getAttribute('aria-label')).toBe('****, 3 kept emails');
  });

  it('Escape after a folded press is left to the app', () => {
    render(<Host {...hostHandlers()} />);
    press(samBubble());
    press(samBubble());
    expect(fireEvent.keyDown(document.body, { key: 'Escape' })).toBe(true);
  });

  it('a hover peek on a stack that is gone does not capture Escape, nor reopen when the stack returns', () => {
    const appEscape = vi.fn();
    window.addEventListener('keydown', appEscape);
    const handlers = hostHandlers();
    const view = render(<Host {...handlers} />);
    fireEvent.pointerEnter(lenaBubble(), { pointerType: 'mouse' });
    fireEvent.click(screen.getByTestId('keep-row-remove'));
    expect(handlers.onRemove).toHaveBeenCalledWith('a1|INBOX|4');
    view.rerender(<Host {...handlers} stacks={[stacks[0]]} />);
    expect(fireEvent.keyDown(document.body, { key: 'Escape' })).toBe(true);
    expect(appEscape).toHaveBeenCalledTimes(1);
    window.removeEventListener('keydown', appEscape);
    view.rerender(<Host {...handlers} />);
    expect(screen.queryByTestId('keep-panel')).toBeNull();
  });

  it('a plain click on the grip does not move the dock', () => {
    const { onMove } = setup();
    const grip = screen.getByTestId('keep-dock-grip');
    fireEvent.pointerDown(grip, { clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerUp(grip, { pointerId: 1 });
    expect(onMove).not.toHaveBeenCalled();
  });
});
