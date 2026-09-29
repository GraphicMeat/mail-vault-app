// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { InfoPopover } from '../InfoPopover';

afterEach(cleanup);

const setup = () => render(
  <div>
    <InfoPopover label="What is this?" data-testid="info-trigger"><p>Explanation text</p></InfoPopover>
    <button type="button">Elsewhere</button>
  </div>,
);
const trigger = () => screen.getByRole('button', { name: 'What is this?' });
const gone = () => waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

describe('InfoPopover', () => {
  it('is a named button that starts closed', () => {
    setup();
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens a named dialog with its content and moves focus into it', () => {
    setup();
    fireEvent.click(trigger());
    const dialog = screen.getByRole('dialog', { name: 'What is this?' });
    expect(dialog.textContent).toContain('Explanation text');
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(dialog);
  });

  it('closes on Escape and returns focus to the button', async () => {
    setup();
    trigger().focus();
    fireEvent.click(trigger());
    fireEvent.keyDown(document, { key: 'Escape' });
    await gone();
    expect(document.activeElement).toBe(trigger());
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
  });

  it('closes when the button is pressed again', async () => {
    setup();
    fireEvent.click(trigger());
    fireEvent.click(trigger());
    await gone();
  });

  it('closes on a click outside the panel', async () => {
    setup();
    fireEvent.click(trigger());
    const layer = document.querySelector('body > div.fixed.inset-0');
    fireEvent.click(layer);
    await gone();
    expect(document.activeElement).toBe(trigger());
  });
});
