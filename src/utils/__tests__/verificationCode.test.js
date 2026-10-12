import { describe, it, expect } from 'vitest';
import { findVerificationCode, looksLikeCodeMail } from '../verificationCode';

// A one-time code sent by mail: what the corner bubble offers to copy. The
// detector reads the subject and whatever body text it is given; a wrong pick
// is worse than none, since the user pastes it somewhere that counts attempts.
describe('findVerificationCode', () => {
  it('reads a six-digit code from the subject', () => {
    expect(findVerificationCode({ subject: 'Your verification code is 364758' })).toBe('364758');
  });

  it('reads a code that leads the subject', () => {
    expect(findVerificationCode({ subject: '123132 is your Instagram code' })).toBe('123132');
  });

  it('reads the code from the body when the subject only announces it', () => {
    expect(findVerificationCode({
      subject: 'Sign in to Acme',
      text: 'Your one-time passcode is 775421. It expires in 10 minutes.',
    })).toBe('775421');
  });

  it('joins a code written in groups', () => {
    expect(findVerificationCode({ subject: 'Your Apple Account code is: 482 913' })).toBe('482913');
    expect(findVerificationCode({ subject: 'Code: 482-913' })).toBe('482913');
  });

  it('keeps a code made of letters and digits', () => {
    expect(findVerificationCode({ subject: 'Your security code is 7KQ2M9' })).toBe('7KQ2M9');
  });

  it('drops the G- prefix Google puts before its digits', () => {
    expect(findVerificationCode({ subject: 'G-123456 is your Google verification code' })).toBe('123456');
  });

  it('takes a four-digit PIN', () => {
    expect(findVerificationCode({ subject: 'Your PIN', text: 'Enter 4821 to continue.' })).toBe('4821');
  });

  it('prefers the number next to the code words over an account number', () => {
    expect(findVerificationCode({
      subject: 'New sign-in',
      text: 'Your account 88213377 has a new login code 554433.',
    })).toBe('554433');
  });

  it('ignores a number inside a link', () => {
    expect(findVerificationCode({
      subject: 'Verify your email',
      text: 'Click https://acme.io/verify?code=883112 or enter 448812 by hand.',
    })).toBe('448812');
  });

  it('returns null for a year', () => {
    expect(findVerificationCode({ subject: 'Verify your account before 2026' })).toBeNull();
  });

  it('returns null for an order number', () => {
    expect(findVerificationCode({ subject: 'Order #48213 confirmed' })).toBeNull();
  });

  it('returns null for a promo code', () => {
    expect(findVerificationCode({ subject: 'Use promo code SAVE20 for 20% off' })).toBeNull();
  });

  it('returns null for a phone number', () => {
    expect(findVerificationCode({ subject: 'Verify your number', text: 'Call us at +1 415 555 0132.' })).toBeNull();
  });

  it('returns null for an amount of money', () => {
    expect(findVerificationCode({ subject: 'Verify the payment', text: 'You paid $1234 today.' })).toBeNull();
  });

  it('returns null for a date', () => {
    expect(findVerificationCode({ subject: 'Verify by 10/12/2026' })).toBeNull();
  });

  it('returns null when nothing says it is a code', () => {
    expect(findVerificationCode({ subject: 'Lunch', text: 'Meet at 123456 Main St.' })).toBeNull();
  });

  it('returns null for a code too far from the code words', () => {
    const filler = 'x'.repeat(400);
    expect(findVerificationCode({ subject: 'Verify your email', text: `${filler} 448812` })).toBeNull();
  });

  it('reads the code words of the other app languages', () => {
    expect(findVerificationCode({ subject: 'Ihr Bestätigungscode lautet 918273' })).toBe('918273');
    expect(findVerificationCode({ subject: 'Votre code de vérification : 564738' })).toBe('564738');
    expect(findVerificationCode({ subject: 'Tu código de verificación es 102938' })).toBe('102938');
    expect(findVerificationCode({ subject: 'Il tuo codice è 837465' })).toBe('837465');
    expect(findVerificationCode({ subject: 'Seu código de verificação: 263748' })).toBe('263748');
    expect(findVerificationCode({ subject: '認証コード: 192837' })).toBe('192837');
    expect(findVerificationCode({ subject: '인증번호 [736251]' })).toBe('736251');
    expect(findVerificationCode({ subject: '您的验证码是 615243' })).toBe('615243');
  });

  it('copes with missing fields', () => {
    expect(findVerificationCode({})).toBeNull();
    expect(findVerificationCode({ subject: null, text: undefined })).toBeNull();
  });
});

describe('looksLikeCodeMail', () => {
  it('is true when the subject names a code, even with none in it', () => {
    expect(looksLikeCodeMail({ subject: 'Your verification code' })).toBe(true);
    expect(looksLikeCodeMail({ subject: 'Sign in to Acme' })).toBe(true);
  });

  it('is false for ordinary mail', () => {
    expect(looksLikeCodeMail({ subject: 'Weekly newsletter' })).toBe(false);
    expect(looksLikeCodeMail({})).toBe(false);
  });
});
