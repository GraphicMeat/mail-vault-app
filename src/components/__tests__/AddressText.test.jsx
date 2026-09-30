// @vitest-environment jsdom
//
// A plain-text body has no anchors. What matters here is not that an <a>
// appears: it is that the message's own text survives verbatim around it, that
// the click opens compose instead of navigating the whole webview at the OS
// mail client, and that nothing in the text can become markup.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { AddressText } from '../email/AddressText';
import { setMailtoComposeOpener } from '../../utils/mailto';

const shell = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('@tauri-apps/plugin-shell', () => ({ open: (...args) => shell.open(...args) }));

describe('AddressText', () => {
  let opened;
  beforeEach(() => {
    opened = [];
    setMailtoComposeOpener((data) => opened.push(data));
  });
  afterEach(() => {
    setMailtoComposeOpener(null);
    cleanup();
  });

  it('renders the text unchanged when it holds no address', () => {
    const { container } = render(<AddressText text="Nothing to click here." />);
    expect(container.textContent).toBe('Nothing to click here.');
    expect(container.querySelectorAll('a')).toHaveLength(0);
  });

  it('links the address and leaves the rest of the message exactly as it was', () => {
    const body = 'Hi,\n\nReach us at partners@blurb.com. Thanks!\n';
    const { container } = render(<AddressText text={body} />);
    // The reader must still see their message, whitespace and all.
    expect(container.textContent).toBe(body);
    const link = container.querySelector('a');
    expect(link.textContent).toBe('partners@blurb.com');
    expect(link.getAttribute('href')).toBe('mailto:partners@blurb.com');
  });

  it('opens compose on click instead of letting the browser follow the href', () => {
    render(<AddressText text="write to a@b.com" accountId="acct-1" />);
    const link = screen.getByText('a@b.com');
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ to: 'a@b.com', _accountId: 'acct-1', _prefill: true });
  });

  it('does not let the click reach the row or bubble it sits inside', () => {
    // The chat bubble and the thread row both have their own click handler;
    // clicking an address must not also select or collapse the message.
    const onParent = vi.fn();
    render(<div onClick={onParent}><AddressText text="a@b.com" /></div>);
    fireEvent.click(screen.getByText('a@b.com'));
    expect(onParent).not.toHaveBeenCalled();
    expect(opened).toHaveLength(1);
  });

  it('renders markup in the message as text, not as elements', () => {
    const { container } = render(<AddressText text={'<img src=x onerror=alert(1)> a@b.com'} />);
    expect(container.querySelector('img')).toBe(null);
    expect(container.textContent).toBe('<img src=x onerror=alert(1)> a@b.com');
  });

  it('links a web address and opens it outside the app instead of navigating the webview', async () => {
    shell.open.mockReset();
    const onParent = vi.fn();
    const body = 'Docs: https://example.com/guide. Or www.example.org';
    const { container } = render(<div onClick={onParent}><AddressText text={body} /></div>);
    expect(container.textContent).toBe(body);
    expect([...container.querySelectorAll('a')].map(a => a.getAttribute('href')))
      .toEqual(['https://example.com/guide', 'https://www.example.org']);

    fireEvent.click(screen.getByText('https://example.com/guide'));

    expect(onParent).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(shell.open).toHaveBeenCalledWith('https://example.com/guide'));
    expect(opened).toHaveLength(0);
  });

  it('links every address in the body, not just the first', () => {
    const { container } = render(<AddressText text="a@b.com and c@d.org" />);
    expect([...container.querySelectorAll('a')].map(a => a.textContent))
      .toEqual(['a@b.com', 'c@d.org']);
  });

  describe('code in the text', () => {
    it('shows `inline` code as code, and the ticks are gone', () => {
      const { container } = render(<AddressText text="run `npm test` now" />);
      expect(container.querySelector('code').textContent).toBe('npm test');
      expect(container.textContent).toBe('run npm test now');
    });

    it('shows a fenced block as a block with its lines kept', () => {
      const { container } = render(<AddressText text={'see:\n```js\nconst a = 1;\nb();\n```\nthanks'} />);
      const block = container.querySelector('pre');
      expect(block.textContent).toBe('const a = 1;\nb();');
      expect(container.textContent).toBe('see:\nconst a = 1;\nb();thanks');
    });

    it('does not make a link out of an address inside code, and still links the rest', () => {
      const { container } = render(<AddressText text="mail a@b.com or `c@d.org`" />);
      expect([...container.querySelectorAll('a')].map(a => a.textContent)).toEqual(['a@b.com']);
      expect(container.querySelector('code').textContent).toBe('c@d.org');
    });

    it('never turns code into markup', () => {
      const { container } = render(<AddressText text={'`<img src=x onerror=alert(1)>`'} />);
      expect(container.querySelector('img')).toBeNull();
      expect(container.querySelector('code').textContent).toBe('<img src=x onerror=alert(1)>');
    });
  });
});
