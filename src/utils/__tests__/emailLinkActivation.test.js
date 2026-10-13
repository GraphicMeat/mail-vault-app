import { describe, it, expect, vi } from 'vitest';
import { activateEmailLink } from '../emailLinkActivation';

const deps = (over = {}) => ({
  accountId: 'acc', linkSafetyEnabled: true, linkSafetyClickConfirm: true,
  openMailtoCompose: vi.fn(), setLinkSafetyAlert: vi.fn(), openUrl: vi.fn(), ...over,
});

describe('activateEmailLink', () => {
  it('composes mailto in-app', () => {
    const d = deps();
    expect(activateEmailLink({ href: 'mailto:a@b.c' }, d)).toBe('compose');
    expect(d.openMailtoCompose).toHaveBeenCalledWith('mailto:a@b.c', 'acc');
  });
  it.each(['cid:x', 'tel:123', '#top', ''])('ignores %j', (href) => {
    const d = deps();
    expect(activateEmailLink({ href }, d)).toBe('ignored');
    expect(d.openUrl).not.toHaveBeenCalled();
  });
  it('raises the link-safety alert instead of opening', () => {
    const d = deps();
    expect(activateEmailLink({ href: 'https://evil.test/', alert: 'red', title: 'Mismatch', text: ' bank.com ' }, d)).toBe('alert');
    expect(d.setLinkSafetyAlert).toHaveBeenCalledWith({ level: 'red', textContent: 'bank.com', actualUrl: 'https://evil.test/', reason: 'Mismatch' });
    expect(d.openUrl).not.toHaveBeenCalled();
  });
  it('opens when confirm is off or the link is clean', () => {
    const d = deps({ linkSafetyClickConfirm: false });
    expect(activateEmailLink({ href: 'https://ok.test/', alert: 'red' }, d)).toBe('opened');
    expect(d.openUrl).toHaveBeenCalledWith('https://ok.test/');
    const d2 = deps();
    expect(activateEmailLink({ href: 'https://ok.test/' }, d2)).toBe('opened');
  });
  it('opens when link safety is disabled even if the link carries an alert', () => {
    const d = deps({ linkSafetyEnabled: false });
    expect(activateEmailLink({ href: 'https://x.test/', alert: 'yellow' }, d)).toBe('opened');
    expect(d.setLinkSafetyAlert).not.toHaveBeenCalled();
    expect(d.openUrl).toHaveBeenCalledWith('https://x.test/');
  });
  it('treats an empty alert attribute as clean and defaults missing text and title to empty', () => {
    const d = deps();
    expect(activateEmailLink({ href: 'https://x.test/', alert: '' }, d)).toBe('opened');
    expect(d.setLinkSafetyAlert).not.toHaveBeenCalled();
    expect(activateEmailLink({ href: 'https://x.test/', alert: 'yellow', title: null, text: null }, d)).toBe('alert');
    expect(d.setLinkSafetyAlert).toHaveBeenCalledWith({ level: 'yellow', textContent: '', actualUrl: 'https://x.test/', reason: '' });
  });
  it('does not touch the alert or compose callbacks for an ordinary link', () => {
    const d = deps();
    activateEmailLink({ href: 'https://ok.test/' }, d);
    expect(d.openMailtoCompose).not.toHaveBeenCalled();
    expect(d.setLinkSafetyAlert).not.toHaveBeenCalled();
  });
});
