#!/usr/bin/env node
// Regenerates the parity fixtures the Rust ports are tested against:
//   src-core/tests/fixtures/sender-check-cases.json      (src-core/src/sender_check.rs)
//   src-core/tests/fixtures/verification-code-cases.json (src-core/src/verification_code.rs)
//
// The expected values come from the OLD JavaScript, read out of git at the
// commit before it was deleted (BASE, origin/main when the move started), not
// from the Rust: each case's input is run through the JS and its answer
// written down. The JS `t()` is replaced by one that returns the catalog key
// and values, which is what the daemon answers instead of text.
//
// Usage, from the repo root (needs git history holding BASE):
//   node src-core/tests/fixtures/gen/parity-fixtures.mjs
// then `git diff --exit-code src-core/tests/fixtures` shows nothing changed.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const BASE = 'f66b58621';

const show = (path) => execFileSync('git', ['show', `${BASE}:${path}`], { encoding: 'utf8' });
const dir = mkdtempSync(join(tmpdir(), 'mv-parity-'));
const T_STUB = 'const t = (key, params) => JSON.stringify({ key, params: params || {} });';
const senderSrc = show('src/utils/senderCheck.js').replace("import { t } from '../i18n/index.js';", T_STUB);
if (!senderSrc.includes(T_STUB)) throw new Error('senderCheck.js no longer imports t the way this script expects');
writeFileSync(join(dir, 'senderCheck.mjs'), senderSrc);
writeFileSync(join(dir, 'verificationCode.mjs'), show('src/utils/verificationCode.js'));
const { checkSenderVerification, parseAuthResults, parseDkimSignature } = await import(pathToFileURL(join(dir, 'senderCheck.mjs')).href);
const { findVerificationCode, looksLikeCodeMail } = await import(pathToFileURL(join(dir, 'verificationCode.mjs')).href);
rmSync(dir, { recursive: true, force: true });

const SENDER = [
  ['no_message', null],
  ['no_from', { authenticationResults: 'mx; spf=pass; dkim=pass' }],
  ['plain_no_auth', { from: { name: 'Alice', address: 'alice@x.example' } }],
  ['verified', { from: { name: 'Alice', address: 'alice@x.example' }, authenticationResults: 'mx.test; spf=pass smtp.mailfrom=x.example; dkim=pass header.d=x.example; dmarc=pass' }],
  ['verified_case', { from: { address: 'Alice@X.Example' }, authenticationResults: 'mx.test; SPF=Pass; DKIM=PASS' }],
  ['spf_pass_dkim_none', { from: { address: 'a@x.example' }, authenticationResults: 'mx; spf=pass; dkim=none; dmarc=pass' }],
  ['dmarc_only', { from: { address: 'a@x.example' }, authenticationResults: 'mx; dmarc=bestguesspass' }],
  ['spf_softfail', { from: { address: 'a@x.example' }, authenticationResults: 'mx; spf=softfail; dkim=pass' }],
  ['all_fail', { from: { address: 'a@x.example' }, authenticationResults: 'mx; spf=fail; dkim=fail; dmarc=fail' }],
  ['first_match_wins', { from: { address: 'a@x.example' }, authenticationResults: 'mx; spf=fail; spf=pass; dkim=pass' }],
  ['first_dkim_pass_then_fail', { from: { address: 'a@x.example' }, authenticationResults: 'mx; spf=pass; dkim=pass header.d=a; dkim=fail header.d=b' }],
  ['word_boundary', { from: { address: 'a@x.example' }, authenticationResults: 'mx; xspf=fail; dkim=passed; arc=pass' }],
  ['temperror', { from: { address: 'a@x.example' }, authenticationResults: 'mx; spf=temperror; dkim=permerror; dmarc=none' }],
  ['long_s_kelvin', { from: { address: 'a@x.example' }, authenticationResults: 'mx; spf=paſs; dKim=fail' }],
  ['name_is_other_email', { from: { name: 'support@paypal.com', address: 'scam@evil.example' } }],
  ['name_is_same_email', { from: { name: 'Support@X.example', address: 'support@x.example' } }],
  ['name_email_subdomain', { from: { name: 'user@example.com', address: 'user@sub.example.com' } }],
  ['name_email_parent', { from: { name: 'user@sub.example.com', address: 'user@example.com' } }],
  ['name_email_quoted', { from: { name: '"paypal@paypal.com"', address: 'x@evil.example' } }],
  ['name_email_escaped_quotes', { from: { name: '\\"service@bank.example\\"', address: 'x@evil.example' } }],
  ['name_quoted_inner_escape', { from: { name: '"Bob \\"The\\" Builder"', address: 'bob@x.example' } }],
  ['name_looks_domain', { from: { name: 'ledger.com', address: 'no-reply@ledger-support.example' } }],
  ['name_looks_domain_upper', { from: { name: 'Ledger.COM', address: 'no-reply@ledger-support.example' } }],
  ['name_domain_same', { from: { name: 'snapcraft.io', address: 'news@snapcraft.io' } }],
  ['name_domain_sub', { from: { name: 'snapcraft.io', address: 'news@forum.snapcraft.io' } }],
  ['name_domain_parent', { from: { name: 'forum.snapcraft.io', address: 'news@snapcraft.io' } }],
  ['name_domain_short_tld', { from: { name: 'foo.c', address: 'a@x.example' } }],
  ['name_domain_digit_tld', { from: { name: 'foo.c0m', address: 'a@x.example' } }],
  ['name_domain_with_space', { from: { name: 'Amazon .com', address: 'a@x.example' } }],
  ['name_domain_leading_dot', { from: { name: '.com', address: 'a@x.example' } }],
  ['name_domain_double_dot', { from: { name: 'a..com', address: 'a@x.example' } }],
  ['name_email_with_space', { from: { name: 'Pay Pal <service@paypal.com>', address: 'a@x.example' } }],
  ['name_email_two_at', { from: { name: 'a@b@c.com', address: 'a@x.example' } }],
  ['name_email_no_dot', { from: { name: 'root@localhost', address: 'a@x.example' } }],
  ['name_email_trailing_dot', { from: { name: 'a@b.', address: 'a@x.example' } }],
  ['name_email_leading_dot_domain', { from: { name: 'a@.com', address: 'a@x.example' } }],
  ['name_email_nbsp', { from: { name: 'a@b.com ', address: 'a@x.example' } }],
  ['name_email_inner_nbsp', { from: { name: 'a b@c.com', address: 'a@x.example' } }],
  ['name_email_nel', { from: { name: 'a\u0085b@c.com', address: 'a@x.example' } }],
  ['name_email_bom', { from: { name: '﻿service@paypal.com', address: 'a@x.example' } }],
  ['name_only_quotes', { from: { name: '"""', address: 'a@x.example' } }],
  ['name_backslashes', { from: { name: '\\\\paypal.com\\\\', address: 'a@x.example' } }],
  ['address_upper_space', { from: { name: 'service@x.example', address: '  Service@X.Example ' } }],
  ['reply_to_object_differs', { from: { address: 'a@x.example' }, replyTo: { address: 'b@other.example' } }],
  ['reply_to_object_matches', { from: { address: 'a@x.example' }, replyTo: { address: 'b@X.example' } }],
  ['reply_to_array', { from: { address: 'a@x.example' }, replyTo: [{ address: 'b@other.example' }, { address: 'c@x.example' }] }],
  ['reply_to_array_empty', { from: { address: 'a@x.example' }, replyTo: [] }],
  ['reply_to_string', { from: { address: 'a@x.example' }, replyTo: 'b@other.example' }],
  ['reply_to_no_at', { from: { address: 'a@x.example' }, replyTo: { address: 'nobody' } }],
  ['reply_to_object_empty', { from: { address: 'a@x.example' }, replyTo: { address: '' } }],
  ['return_path_differs_info_only', { from: { address: 'a@x.example' }, returnPath: 'bounce@mailer.example' }],
  ['return_path_angle', { from: { address: 'a@x.example' }, returnPath: '<bounce@Mailer.example>' }],
  ['return_path_with_warning', { from: { address: 'a@x.example' }, returnPath: 'bounce@mailer.example', replyTo: { address: 'b@other.example' } }],
  ['return_path_with_verified', { from: { address: 'a@x.example' }, returnPath: 'bounce@mailer.example', authenticationResults: 'mx; spf=pass; dkim=pass' }],
  ['danger_and_warning', { from: { name: 'paypal.com', address: 'a@x.example' }, replyTo: { address: 'b@other.example' }, returnPath: 'r@third.example', authenticationResults: 'mx; spf=fail; dkim=pass; dmarc=fail' }],
  ['from_address_missing', { from: { name: 'Someone' }, authenticationResults: 'mx; spf=pass; dkim=pass' }],
  ['from_address_no_at', { from: { name: 'x.example', address: 'mailer-daemon' } }],
  ['multi_at_address', { from: { address: 'a@b@x.example' }, replyTo: { address: 'r@b' } }],
  ['dkim_sig_summary', { from: { address: 'a@x.example' }, authenticationResults: 'mx; dkim=pass', dkimSignature: 'a=rsa-sha256; d=brand.test; s=k1' }],
  ['dkim_sig_upper_partial', { from: { address: 'a@x.example' }, dkimSignature: 'a=ED25519-SHA256; d=Brand.test' }],
  ['dkim_from_results', { from: { address: 'a@x.example' }, authenticationResults: 'mx.test; dkim=pass header.d=brand.test header.s=k1 header.a=ed25519-sha256; spf=pass' }],
  ['dkim_summary_over_results', { from: { address: 'a@x.example' }, dkimSignature: 'a=rsa-sha256', authenticationResults: 'mx; dkim=pass header.a=rsa-sha1 header.d=brand.test header.s=k9' }],
  ['dkim_none_named', { from: { address: 'a@x.example' }, authenticationResults: 'mx; dkim=pass header.i=@brand.test header.b=abc' }],
  ['dkim_bad_token_falls_back', { from: { address: 'a@x.example' }, dkimSignature: 'a=<b>; d=brand_test; s=k/1', authenticationResults: 'mx; dkim=pass header.a=rsa-sha256 header.d=Brand.Test header.s=K1' }],
  ['dkim_last_tag_wins', { from: { address: 'a@x.example' }, dkimSignature: 'a=rsa-sha1; a=rsa-sha256; d=one.test; d=two.test' }],
  ['dkim_value_with_equals', { from: { address: 'a@x.example' }, dkimSignature: 's=k=1; d=x.test' }],
  ['dkim_results_upper_tag_ignored', { from: { address: 'a@x.example' }, authenticationResults: 'mx; dkim=pass HEADER.D=brand.test' }],
  ['dkim_selector_dots', { from: { address: 'a@x.example' }, dkimSignature: ' A = rsa-sha256 ;  S = sel.v2_x ; D = mail.brand.test ' }],
  ['dkim_only_no_from', { dkimSignature: 'a=rsa-sha256; d=brand.test; s=k1' }],
];

const CODES = [
  ['subject_six', { subject: 'Your verification code is 364758' }],
  ['subject_lead', { subject: '123132 is your Instagram code' }],
  ['body_announced', { subject: 'Sign in to Acme', text: 'Your one-time passcode is 775421. It expires in 10 minutes.' }],
  ['groups_space', { subject: 'Your Apple Account code is: 482 913' }],
  ['groups_dash', { subject: 'Code: 482-913' }],
  ['alnum', { subject: 'Your security code is 7KQ2M9' }],
  ['google_prefix', { subject: 'G-123456 is your Google verification code' }],
  ['pin_four', { subject: 'Your PIN', text: 'Enter 4821 to continue.' }],
  ['account_number_vs_code', { subject: 'New sign-in', text: 'Your account 88213377 has a new login code 554433.' }],
  ['link_number', { subject: 'Verify your email', text: 'Click https://acme.io/verify?code=883112 or enter 448812 by hand.' }],
  ['year', { subject: 'Verify your account before 2026' }],
  ['order', { subject: 'Order #48213 confirmed' }],
  ['promo', { subject: 'Use promo code SAVE20 for 20% off' }],
  ['phone', { subject: 'Verify your number', text: 'Call us at +1 415 555 0132.' }],
  ['money', { subject: 'Verify the payment', text: 'You paid $1234 today.' }],
  ['date', { subject: 'Verify by 10/12/2026' }],
  ['no_keyword', { subject: 'Lunch', text: 'Meet at 123456 Main St.' }],
  ['too_far', { subject: 'Verify your email', text: `${'x'.repeat(400)} 448812` }],
  ['de', { subject: 'Ihr Bestätigungscode lautet 918273' }],
  ['fr', { subject: 'Votre code de vérification : 564738' }],
  ['es', { subject: 'Tu código de verificación es 102938' }],
  ['it', { subject: 'Il tuo codice è 837465' }],
  ['pt', { subject: 'Seu código de verificação: 263748' }],
  ['ja', { subject: '認証コード: 192837' }],
  ['ko', { subject: '인증번호 [736251]' }],
  ['zh', { subject: '您的验证码是 615243' }],
  ['empty', {}],
  ['nulls', { subject: null, text: null }],
  ['cjk_keyword_far', { subject: '验证码', text: `${'中'.repeat(195)} 615243` }],
  ['cjk_keyword_edge', { subject: '验证码', text: `${'中'.repeat(198)}615243` }],
  ['cjk_keyword_over', { subject: '验证码', text: `${'中'.repeat(201)}615243` }],
  ['emoji_near', { subject: 'Your code', text: `${'😀'.repeat(98)} 615243` }],
  ['emoji_far', { subject: 'Your code', text: `${'😀'.repeat(101)} 615243` }],
  ['emoji_before_code', { subject: 'Your code 😀615243' }],
  ['emoji_window_before', { subject: 'Your code', text: `order ${'😀'.repeat(18)} 615243` }],
  ['emoji_window_before_short', { subject: 'Your code', text: `order ${'😀'.repeat(16)} 615243` }],
  ['fullwidth_digits', { subject: 'Your code is ６１５２４３' }],
  ['nbsp_group', { subject: 'Your code is 615 243' }],
  ['soft_hyphen_inside', { subject: 'Your code is 615­243' }],
  ['zwsp_inside', { subject: 'Your code is 61​5243' }],
  ['ligature_fi', { subject: 'Conﬁrm', text: '554433' }],
  ['tie_first_wins', { subject: 'code 111111 code 222222' }],
  ['closer_wins', { subject: 'Verify', text: 'filler filler filler 111111 then much later your code 222222' }],
  ['percent', { subject: 'Your code', text: '123456%' }],
  ['percent_space_word', { subject: 'Your code', text: '123456 %d' }],
  ['percent_space_end', { subject: 'Your code', text: '123456 % off' }],
  ['unit_minutes', { subject: 'Your code', text: 'valid for 1234 minutes' }],
  ['unit_kb', { subject: 'Your code', text: 'size 4096 KB' }],
  ['unit_word_boundary', { subject: 'Your code', text: '4096 kbps 554433' }],
  ['unit_far', { subject: 'Your code', text: '554433          minutes' }],
  ['phone_groups', { subject: 'Your code', text: 'call 0800 123456' }],
  ['dash_digits_before', { subject: 'Your code', text: 'ref 12-345678' }],
  ['hash_before', { subject: 'Your code', text: 'ticket #556677' }],
  ['hash_space_before', { subject: 'Your code', text: 'see # 556677' }],
  ['at_before', { subject: 'Your code', text: 'mail me@556677' }],
  ['dot_before', { subject: 'Your code', text: 'version 1.556677' }],
  ['euro_before', { subject: 'Your code', text: 'pay €556677' }],
  ['customer_id', { subject: 'Your login code', text: 'Customer ID: 99887766. Your code: 554433' }],
  ['reference_no', { subject: 'Confirm', text: 'Reference no. 445566' }],
  ['tracking_number', { subject: 'Confirm', text: 'Tracking number 44556677' }],
  ['order_far_in_window', { subject: 'Your code', text: 'Order placed, thanks. Your code is 445566' }],
  ['nine_digits', { subject: 'Your code', text: '123456789' }],
  ['three_digits', { subject: 'Your code', text: '123' }],
  ['alnum_lower', { subject: 'Your code', text: 'abc123' }],
  ['alnum_letters_only', { subject: 'Your code', text: 'ABCDEF' }],
  ['alnum_nine', { subject: 'Your code', text: 'AB12CD34E' }],
  ['alnum_late_digit', { subject: 'Your code', text: 'ABCDEFG1' }],
  ['alnum_late_letter', { subject: 'Your code', text: '1234567A' }],
  ['alnum_eight_late', { subject: 'Your code', text: 'ABCDEFGH1' }],
  ['alnum_run_long', { subject: 'Your code', text: 'ABCDEFGHI12' }],
  ['group_then_digit', { subject: 'Your code', text: '123 456 7' }],
  ['group_then_word', { subject: 'Your code', text: '123 456abc' }],
  ['code_underscore_after', { subject: 'Your code', text: '123456_' }],
  ['code_trailing_space_digit', { subject: 'Your code', text: '123456 7' }],
  ['code_dash_digit', { subject: 'Your code', text: '123456-7' }],
  ['adjacent_codes', { subject: 'Your code', text: '123456 654321' }],
  ['keyword_inside_word', { subject: 'barcodes and decoder', text: '554433' }],
  ['keyword_codes', { subject: 'Your codes', text: '554433' }],
  ['keyword_2fa', { subject: '2FA', text: '554433' }],
  ['keyword_one_time', { subject: 'One time password', text: '554433' }],
  ['keyword_onetime', { subject: 'onetime', text: '554433' }],
  ['keyword_login', { subject: 'Log-in alert', text: '554433' }],
  ['keyword_sicherheits', { subject: 'Sicherheitscode', text: '554433' }],
  ['keyword_securite', { subject: 'Code de sécurité', text: '554433' }],
  ['keyword_upper', { subject: 'VERIFICATION', text: '554433' }],
  ['keyword_accent_upper', { subject: 'CÓDIGO', text: '554433' }],
  ['subject_and_text_joined', { subject: 'Your code', text: '' }],
  ['newline_between', { subject: 'Your code:', text: '554433' }],
  ['year_and_code', { subject: 'Your 2024 code is 554433' }],
  ['two_groups', { subject: 'Your code 123 456 789' }],
  ['dollar_space', { subject: 'Your code', text: 'Total $ 554433' }],
  ['plus_space', { subject: 'Your code', text: 'Call + 554433' }],
  ['phone_word', { subject: 'Your code', text: 'phone: 554433' }],
  ['account_code', { subject: 'Your code', text: 'account code 554433' }],
  ['zip', { subject: 'Your code', text: 'ZIP 90210 and code 554433' }],
  ['non_string', { subject: 12345, text: 554433 }],
];

const LOOKS = [
  ['verification', { subject: 'Your verification code' }],
  ['sign_in', { subject: 'Sign in to Acme' }],
  ['newsletter', { subject: 'Weekly newsletter' }],
  ['empty', {}],
  ['text_only', { text: 'your otp' }],
  ['cjk', { subject: '確認コード' }],
  ['inside_word', { subject: 'barcodes' }],
  ['kelvin_sign_k', { subject: 'toKen' }],
  ['long_s', { subject: 'ſecurity' }],
];

// What JSON keeps of an input (undefined fields dropped), as the fixture holds it.
const asStored = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

const sender = SENDER.map(([name, input]) => {
  const v = checkSenderVerification(input);
  const tooltip = v.tooltip ? v.tooltip.split('\n').map((l) => JSON.parse(l)) : [];
  const issues = (v.issues || []).map((i) => ({ level: i.level, ...JSON.parse(i.text), ...(i.details ? { details: i.details } : {}) }));
  return {
    name, input: asStored(input),
    expected: { status: v.status, tooltip, issues, auth: parseAuthResults(input?.authenticationResults), dkim: parseDkimSignature(input) },
  };
});
const codes = CODES.map(([name, input]) => ({ name, input: asStored(input), expected: findVerificationCode(input) }));
const looks = LOOKS.map(([name, input]) => ({ name, input: asStored(input), expected: looksLikeCodeMail(input) }));

const write = (file, comment, body) =>
  writeFileSync(join('src-core/tests/fixtures', file), `${JSON.stringify({ _comment: comment, ...body }, null, 1)}\n`);
write('sender-check-cases.json',
  'Generated by running the deleted src/utils/senderCheck.js (checkSenderVerification, parseAuthResults, parseDkimSignature) on each input, with t() returning {key, params}. src-core/src/sender_check.rs must answer the same.',
  { cases: sender });
write('verification-code-cases.json',
  'Generated by running the deleted src/utils/verificationCode.js (findVerificationCode, looksLikeCodeMail) on each input. src-core/src/verification_code.rs must answer the same.',
  { codes, looks });
console.log(`parity fixtures from ${BASE}: ${sender.length} sender, ${codes.length} code, ${looks.length} code-mail cases`);
