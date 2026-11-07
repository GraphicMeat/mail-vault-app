// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import AddAccount from '../AddAccount.jsx';
import { ERROR_KEYS, errorKey } from '../errors.js';
import { t } from '../i18n.js';
import en from '../../i18n/locales/en.json';

afterEach(cleanup);

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

const field = (key) => screen.getByLabelText(t(key));

function fillFirstStep(email = 'ada@example.test', password = 'secret-pw') {
  fireEvent.change(field('mobile.add.email'), { target: { value: email } });
  fireEvent.change(field('mobile.add.password'), { target: { value: password } });
  fireEvent.click(screen.getByRole('button', { name: t('common.next') }));
}

describe('AddAccount', () => {
  it('asks for email and password first, then prefills the server from the domain', () => {
    render(<AddAccount onSubmit={vi.fn()} />);
    expect(screen.getByRole('button', { name: t('common.next') }).disabled).toBe(true);
    fillFirstStep('ada@mail.example.test');
    expect(field('mobile.add.host').value).toBe('imap.mail.example.test');
    expect(field('mobile.add.port').value).toBe('993');
    expect(field('account.security').value).toBe('ssl');
    // Editable: a typed host is kept, and STARTTLS moves the default port.
    fireEvent.change(field('mobile.add.host'), { target: { value: 'mx.example.test' } });
    fireEvent.change(field('account.security'), { target: { value: 'starttls' } });
    expect(field('mobile.add.host').value).toBe('mx.example.test');
    expect(field('mobile.add.port').value).toBe('143');
  });

  it('prefills smtp from the address domain and shows the smtp fields on the server step', () => {
    render(<AddAccount onSubmit={vi.fn()} />);
    fillFirstStep('ada@mail.example.test');
    expect(field('mobile.add.smtpHost').value).toBe('smtp.mail.example.test');
    expect(field('mobile.add.smtpPort').value).toBe('465');
    expect(field('mobile.add.smtpSecurity').value).toBe('ssl');
    // STARTTLS moves the default SMTP port to 587; a typed host is kept.
    fireEvent.change(field('mobile.add.smtpSecurity'), { target: { value: 'starttls' } });
    expect(field('mobile.add.smtpPort').value).toBe('587');
    fireEvent.change(field('mobile.add.smtpHost'), { target: { value: 'out.example.test' } });
    expect(field('mobile.add.smtpHost').value).toBe('out.example.test');
    // The IMAP host changing does not touch the SMTP one.
    fireEvent.change(field('mobile.add.host'), { target: { value: 'mx.example.test' } });
    expect(field('mobile.add.smtpHost').value).toBe('out.example.test');
  });

  it('shows the translated SMTP_FAILED error and keeps the password', async () => {
    const onSubmit = vi.fn(async () => ({ ok: false, code: 'SMTP_FAILED' }));
    render(<AddAccount onSubmit={onSubmit} />);
    fillFirstStep();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('mobile.add.signIn') }));
    });
    expect(screen.getByRole('alert').textContent).toBe(t('mobile.error.SMTP_FAILED'));
    expect(t('mobile.error.SMTP_FAILED')).not.toBe('mobile.error.SMTP_FAILED');
    expect(field('mobile.add.password').value).toBe('secret-pw');
  });

  it('submit_disabled_while_testing', async () => {
    const pending = deferred();
    const onSubmit = vi.fn(() => pending.promise);
    render(<AddAccount onSubmit={onSubmit} />);
    fillFirstStep();
    const submit = screen.getByRole('button', { name: t('mobile.add.signIn') });
    fireEvent.click(submit);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({
      email: 'ada@example.test', password: 'secret-pw', imapHost: 'imap.example.test', imapPort: 993, security: 'ssl',
      smtpHost: 'smtp.example.test', smtpPort: 465, smtpSecurity: 'ssl',
    });
    const busy = screen.getByRole('button', { name: t('mobile.add.signingIn') });
    expect(busy.disabled).toBe(true);
    fireEvent.click(busy);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    await act(async () => { pending.resolve({ ok: true }); });
  });

  it('auth_failed_shows_translated_error_and_keeps_form', async () => {
    const onSubmit = vi.fn(async () => ({ ok: false, code: 'AUTH_FAILED' }));
    render(<AddAccount onSubmit={onSubmit} />);
    fillFirstStep();
    fireEvent.change(field('mobile.add.port'), { target: { value: '1993' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('mobile.add.signIn') }));
    });
    expect(screen.getByRole('alert').textContent).toBe(t('mobile.error.AUTH_FAILED'));
    expect(t('mobile.error.AUTH_FAILED')).not.toBe('mobile.error.AUTH_FAILED');
    // The form stays as typed; only the password is cleared (it never outlives a submit).
    expect(screen.getByText('ada@example.test')).toBeTruthy();
    expect(field('mobile.add.host').value).toBe('imap.example.test');
    expect(field('mobile.add.port').value).toBe('1993');
    expect(field('account.security').value).toBe('ssl');
    expect(field('mobile.add.password').value).toBe('');
    expect(screen.getByRole('button', { name: t('mobile.add.signIn') }).disabled).toBe(true);
    fireEvent.change(field('mobile.add.password'), { target: { value: 'again' } });
    expect(screen.getByRole('button', { name: t('mobile.add.signIn') }).disabled).toBe(false);
    // Back to the first step: the address is still there.
    fireEvent.click(screen.getByRole('button', { name: t('common.back') }));
    expect(field('mobile.add.email').value).toBe('ada@example.test');
  });

  it('a network error keeps the password for the retry', async () => {
    for (const code of ['HOST_UNREACHABLE', 'TLS_FAILED', 'TIMEOUT']) {
      const onSubmit = vi.fn(async () => ({ ok: false, code }));
      render(<AddAccount onSubmit={onSubmit} />);
      fillFirstStep();
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: t('mobile.add.signIn') }));
      });
      expect(screen.getByRole('alert').textContent).toBe(t(errorKey(code)));
      expect(field('mobile.add.password').value, code).toBe('secret-pw');
      // Fix the server and try again without retyping.
      fireEvent.change(field('mobile.add.host'), { target: { value: 'mx.example.test' } });
      const retry = screen.getByRole('button', { name: t('mobile.add.signIn') });
      expect(retry.disabled).toBe(false);
      await act(async () => { fireEvent.click(retry); });
      expect(onSubmit).toHaveBeenLastCalledWith({
        email: 'ada@example.test', password: 'secret-pw', imapHost: 'mx.example.test', imapPort: 993, security: 'ssl',
        smtpHost: 'smtp.example.test', smtpPort: 465, smtpSecurity: 'ssl',
      });
      cleanup();
    }
  });

  it('a thrown submit shows the generic error', async () => {
    const onSubmit = vi.fn(async () => { throw new Error('bridge gone'); });
    render(<AddAccount onSubmit={onSubmit} />);
    fillFirstStep();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('mobile.add.signIn') }));
    });
    expect(screen.getByRole('alert').textContent).toBe(t('mobile.error.INTERNAL'));
  });

  it('every engine code has a translated message, and an unknown one falls back', () => {
    for (const code of ['AUTH_FAILED', 'HOST_UNREACHABLE', 'TLS_FAILED', 'TIMEOUT', 'DUPLICATE', 'INVALID', 'SMTP_FAILED', 'INTERNAL']) {
      expect(ERROR_KEYS[code], code).toBeDefined();
      expect(en[ERROR_KEYS[code]], code).toBeTruthy();
    }
    expect(errorKey('SOMETHING_NEW')).toBe(ERROR_KEYS.INTERNAL);
    expect(errorKey(undefined)).toBe(ERROR_KEYS.INTERNAL);
  });

  it('cancel is offered only when there is somewhere to go back to', () => {
    const onCancel = vi.fn();
    render(<AddAccount onSubmit={vi.fn()} />);
    expect(screen.queryByRole('button', { name: t('common.cancel') })).toBeNull();
    cleanup();
    render(<AddAccount onSubmit={vi.fn()} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('button', { name: t('common.cancel') }));
    expect(onCancel).toHaveBeenCalled();
  });

  it('inputs use the right keyboards and no autofill of the password into anything but a password field', () => {
    render(<AddAccount onSubmit={vi.fn()} />);
    expect(field('mobile.add.email').getAttribute('type')).toBe('email');
    expect(field('mobile.add.password').getAttribute('type')).toBe('password');
    fillFirstStep();
    expect(field('mobile.add.port').getAttribute('inputmode')).toBe('numeric');
  });
});
