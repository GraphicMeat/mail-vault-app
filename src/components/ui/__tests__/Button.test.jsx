// @vitest-environment jsdom
// The `touch` size: the phone's buttons are desktop's Button at a finger's size (44px). The
// desktop sizes and the defaults stay as they were.
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { Button } from '../Button';

afterEach(cleanup);

const classes = (el) => el.className.split(/\s+/).filter(Boolean);

describe('Button', () => {
  it('touch is at least 44px tall, with the md padding and type', () => {
    const { getByRole } = render(<Button size="touch">Send</Button>);
    expect(classes(getByRole('button'))).toEqual(expect.arrayContaining(['min-h-11', 'px-4', 'text-sm', 'gap-2']));
  });

  it('touch as an icon button is a 44px square', () => {
    const { getByRole } = render(<Button size="touch" icon aria-label="Attach">+</Button>);
    const c = classes(getByRole('button', { name: 'Attach' }));
    expect(c).toEqual(expect.arrayContaining(['min-w-11', 'min-h-11', 'p-2.5']));
    expect(c).not.toContain('px-4');
  });

  it('touch keeps the busy spinner, at the md size', () => {
    const { getByRole } = render(<Button size="touch" variant="primary" loading>Send</Button>);
    const button = getByRole('button');
    expect(button.disabled).toBe(true);
    const spinner = button.querySelector('svg');
    expect(spinner).toBeTruthy();
    expect(spinner.getAttribute('width')).toBe('14');
  });

  it('the defaults are unchanged: secondary, md, rounded-lg', () => {
    const { getByRole } = render(<Button>Cancel</Button>);
    const c = classes(getByRole('button'));
    expect(c).toEqual(expect.arrayContaining(['px-4', 'py-2', 'text-sm', 'gap-2', 'rounded-lg', 'bg-mail-surface']));
    expect(c).not.toContain('min-h-11');
    expect(getByRole('button').getAttribute('type')).toBe('button');
  });
});
