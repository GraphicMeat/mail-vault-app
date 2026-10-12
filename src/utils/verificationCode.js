// A one-time code sent by mail, read out of the subject and body text so the
// corner bubble can offer to copy it. Picking a wrong number is worse than
// picking none (the user pastes it somewhere that counts attempts), so a
// number is a code only when the mail talks about codes, the number sits near
// those words, and nothing around it says order, phone, money, date or link.

// Words that say the mail carries a code, in the app's languages. Stems, so
// "verification", "verify" and "verified" all count.
const KEYWORDS = /\b(?:codes?|otp|passcode|pin|2fa|mfa|one[- ]?time|verif\w*|authenticat\w*|security|token|confirm\w*|sign[- ]?in|log[- ]?in)\b|c[oó]digo|verificaci[oó]n|codice|verifica|best[äa]tigung|sicherheits|verifizier|einmal|v[ée]rification|s[ée]curit[ée]|認証|確認コード|検証|ワンタイム|인증|확인 코드|验证码|驗證碼|校验码/giu;

// A number right after one of these is something else with a number.
const NOT_A_CODE_BEFORE = /\b(?:promo|discount|coupon|voucher|referral|order|invoice|tracking|ticket|booking|reference|ref|account|customer|phone|tel|call|fax|zip|postal)\b\W*(?:code|no|number|nr|id)?\W*$/i;
// A unit or a percent sign after the number makes it a quantity.
const UNIT_AFTER = /^\s*(?:%|min(?:ute)?s?|sec(?:ond)?s?|h(?:ou)?rs?|days?|px|[kmg]b)\b/i;
// Money, a link, a tag or an email address right before the number.
const SIGN_BEFORE = /[#$€£¥+/=@]$/;
// The number continues a group of digits: a phone number, a card number.
const DIGITS_BEFORE = /\d[ -]$/;
const YEAR = /^(?:19|20)\d\d$/;

// Six digits in two groups, four to eight digits, or six to eight capitals and
// digits with at least one of each. The lead char is matched, not looked
// behind (older WebKit has no lookbehind), and given back.
const CANDIDATE = /(^|[^\w#$€£¥+/=.@])(\d{3}[ -]\d{3}|\d{4,8}|(?=[A-Z0-9]{0,7}\d)(?=[A-Z0-9]{0,7}[A-Z])[A-Z0-9]{6,8})(?![\w%]|[ -]\d)/g;

// The farthest a code may sit from the words that announce it.
const NEAR = 200;

// ZWSP ZWNJ ZWJ, WORD JOINER, BOM, SOFT HYPHEN
const INVISIBLE = /[​‌‍⁠﻿­]/g;

const clean = (s) => (s == null ? '' : String(s)).normalize('NFKC').replace(INVISIBLE, '');

function keywordSpans(text) {
  const spans = [];
  for (const m of text.matchAll(KEYWORDS)) spans.push([m.index, m.index + m[0].length]);
  return spans;
}

function distance(spans, start, end) {
  let best = Infinity;
  for (const [a, b] of spans) {
    const gap = a >= end ? a - end : start >= b ? start - b : 0;
    if (gap < best) best = gap;
  }
  return best;
}

/** True when the mail talks about a code at all, whether or not one is in the text. */
export function looksLikeCodeMail({ subject, text } = {}) {
  KEYWORDS.lastIndex = 0;
  return KEYWORDS.test(`${clean(subject)}\n${clean(text)}`);
}

/** The code in the mail, as the user would type it, or null. */
export function findVerificationCode({ subject, text } = {}) {
  const whole = `${clean(subject)}\n${clean(text)}`;
  const spans = keywordSpans(whole);
  if (!spans.length) return null;

  let best = null;
  for (const m of whole.matchAll(CANDIDATE)) {
    const raw = m[2];
    const start = m.index + m[1].length;
    const end = start + raw.length;
    const before = whole.slice(Math.max(0, start - 40), start);
    const after = whole.slice(end, end + 12);
    if (DIGITS_BEFORE.test(before)) continue;
    if (SIGN_BEFORE.test(before.trimEnd())) continue;
    if (NOT_A_CODE_BEFORE.test(before)) continue;
    if (UNIT_AFTER.test(after)) continue;
    if (YEAR.test(raw)) continue;
    const gap = distance(spans, start, end);
    if (gap > NEAR) continue;
    if (!best || gap < best.gap) best = { gap, code: /^\d/.test(raw) ? raw.replace(/[ -]/g, '') : raw };
  }
  return best ? best.code : null;
}
