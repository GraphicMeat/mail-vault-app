// @vitest-environment jsdom
// Explicit capture only. Ordinary tests compare the immutable actual-JS corpus.
import { it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
vi.mock('../../../../src/utils/dateFormat', () => ({
  formatDateTime: value => `date:${value}`, formatTime: () => '', formatDateOnly: () => '', formatDateLong: () => '', formatWeekdayShort: () => '',
}));
import { computeReplyRecipients, buildReplyHeaders } from '../../../../src/utils/emailParser';
import { buildQuoteBlocks } from '../../../../src/utils/replyQuote';
import { textToHtml, htmlToText } from '../../../../src/components/RichTextEditor';
import { replyWireHtml, splitWireHtml } from '../../../../src/utils/quoteWire';
import { composeIdentities, resolveInitialComposeIdentity } from '../../../../src/utils/sendAsSuggestions';
import { invalidRecipients } from '../../../../src/utils/recipientTokens';
import { missingAttachment } from '../../../../src/utils/missingAttachment';
import { parseMailto } from '../../../../src/utils/mailto';
import { routeSend } from '../../../../src/utils/sendPlan';
import { zonedTimeToEpoch, isPastLocalTime, wallClockAt } from '../../../../src/utils/scheduledTime';
import { hasPremiumAccess, useSettingsStore } from '../../../../src/stores/settingsStore';
const copy = value => JSON.parse(JSON.stringify(value));
const accounts = [{ id: 'one', email: 'John.Doe+login@gmail.com' }, { id: 'two', email: 'other@example.test' }];
const settings = { sendAsAddresses: { one: 'default@example.test' }, aliases: { one: [{ address: 'alias@example.test' }], two: [{ address: 'second@example.test' }] } };
const sourceFiles = ['src/utils/emailParser.js', 'src/utils/ownAddresses.js', 'src/utils/emailIdentity.js', 'src/utils/replyQuote.js', 'src/utils/quoteWire.js', 'src/components/RichTextEditor.jsx', 'src/utils/sendAsSuggestions.js', 'src/utils/recipientTokens.js', 'src/utils/missingAttachment.js', 'src/utils/mailto.js', 'src/utils/sendPlan.js', 'src/utils/scheduledTime.js', 'src/stores/settingsStore.js', 'src/components/ComposeModal.jsx'];
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');
it('captures real JS compose preparation and scheduling behavior', () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-25T00:00:00.000Z'));
  const cases = [];
  const record = (category, name, input, output) => cases.push({ category, name, input: copy(input), output: copy(output) });
  const own = composeIdentities(accounts, settings.sendAsAddresses, settings.aliases).map(i => i.address).concat('removed@example.test');
  const base = { from: { address: 'Sender@outside.test', name: '<Sender & Co>' }, to: [{ address: 'default@example.test' }, { address: 'Friend@outside.test' }], cc: [{ address: 'copy@outside.test' }], bcc: [{ address: 'BCC_SENTINEL@example.test' }], subject: 'Topic <&>', date: '2026-10-24T12:34:00Z', messageId: 'parent@test', references: '<root@test>\r\n <root@test>', text: 'original <text> &\n\nlast' };
  const messages = [
    ['sender', {}], ['first-list-reply-to', { replyTo: [{ address: 'list@outside.test' }, { address: 'ignored@outside.test' }] }],
    ...own.map((address, i) => [`own-${i}`, { from: { address } }]),
    ['gmail-fold', { from: { address: 'johndoe+tag@googlemail.com' } }],
    ['non-gmail-plus', { from: { address: 'other+tag@example.test' } }], ['non-gmail-dots', { from: { address: 'o.ther@example.test' } }],
    ['note-self', { from: { address: own[0] }, to: [{ address: own[0] }] }],
    ['per-field-case-and-cross-field', { to: [{ address: 'Friend@outside.test' }, { address: 'friend@outside.test' }, { address: 'Sender@outside.test' }], cc: [{ address: 'FRIEND@outside.test' }, { address: 'friend@outside.test' }] }],
    ['all-account-identities', { to: own.map(address => ({ address })), cc: own.map(address => ({ address })) }],
    ['missing-sender', { from: null, to: [] }], ['empty-reply-to', { replyTo: [{ address: '' }] }],
    ['array-references-coercion', { messageId: '', message_id: '<<snake@test>>', references: ['root@test same@test', 'same@test', 42, null, ['nested@test', 'pair@test']] }],
    ['no-id', { messageId: null, references: [] }], ['duplicate-parent', { references: ['parent@test', 'root@test'] }],
    ['exact-re-prefix', { subject: 'Re: Ready' }], ['lower-re-prefix', { subject: 're: Ready' }], ['exact-fwd-prefix', { subject: 'Fwd: Ready' }],
    ['html-table-CID', { html: '<style>td{color:red}</style><table><tr><td>&raw<img src="cid:logo"></td></tr></table>' }],
    ['selected-html', { _selectedQuoteHtml: '<p>selected</p>' }], ['empty-selection', { _selectedQuoteHtml: '' }],
    ['context-separate', { _threadContext: [{ from: { address: 'context@outside.test' }, to: [], subject: 'Context', date: 'context-date', text: 'context only', bcc: base.bcc }] }],
    ['snippet-only', { _bodyLoading: true, text: 'snippet stand-in' }], ['loading-html-kept', { _bodyLoading: true, html: '<p>real HTML</p>', text: 'snippet' }], ['empty-body', { text: '', date: 0 }],
  ];
  for (const [name, extra] of messages) for (const mode of ['reply', 'replyAll', 'forward']) {
    const message = { ...base, ...extra };
    // Real current click path removes text only for a loading header.
    const safe = { ...message }; if (safe._bodyLoading) delete safe.text;
    const blocks = buildQuoteBlocks(safe, 'Original message');
    const subject = safe.subject || '';
    const candidate = mode === 'forward' ? `WG: ${subject}` : `Re: ${subject}`;
    const quote = mode === 'forward' ? blocks.quotedHeaderHtml + blocks.fullQuotedBodyHtml : blocks.quotedHtml;
    record('message', `${name}-${mode}`, { message, mode, own, subjectCandidate: candidate, label: 'Original message' }, {
      ...(mode === 'forward' ? { to: '', cc: '', inReplyTo: '', references: '' } : { ...computeReplyRecipients(safe, mode, own), ...buildReplyHeaders(safe) }),
      bcc: '', subject: subject.startsWith(mode === 'forward' ? 'Fwd:' : 'Re:') ? subject : candidate,
      ...blocks, quotedHtml: quote, fullOriginalHtml: blocks.quotedHeaderHtml + blocks.fullQuotedBodyHtml,
      bodyAvailable: !!(safe.html || safe.text),
    });
  }
  for (const href of [
    'mailto:a+tag@example.test', ' MAILTO:a%2Btag@example.test,b@example.test?to=c%40example.test&to=d@example.test ',
    'mailto:?cc=first@example.test&cc=last@example.test&bcc=blind@example.test&subject=first&subject=last&body=%3Cb%3E%26%0D%0Aline%0Aend%0Dtail&X-Silent=drop',
    'mailto:one%40example.test%ZZ?body=%41%ZZ', 'mailto:a%2Cb@example.test?bcc=x%2By@example.test', 'mailto:?body=&subject=+', 'https://example.test', '',
  ]) record('mailto', href, { href, accountId: 'two' }, parseMailto(href, 'two'));
  for (const value of ['', 'bad', 'local@domain', 'good@example.test', '"Doe, Jane" <j@example.test>;bad\nnext@local', '"Escaped \\" name" <a@example.test>, x@example.test', 'a@example.test b@example.test', 'a@example.test\r\nBcc: injected@example.test', '<x@example.test>', 'name <x@example.test> trailing', 'a@example.test; b@example.test\nlast@bad']) record('invalid', value, value, invalidRecipients(value));
  const words = 'attach|attached|attaching|attachment|attachments|enclosed|enclosing|anhang|anhänge|anhängen|angehängt|anbei|beigefügt|adjunto|adjunta|adjuntos|adjuntas|adjuntado|adjunté|pièce jointe|pièces jointes|ci-joint|ci-jointe|ci-joints|ci-jointes|allegato|allegata|allegati|allegate|anexo|anexa|anexos|anexas|anexado|anexada|anexei|添付|첨부|附件|附上|随附'.split('|');
  for (const bodyText of [...words, 'detached', 'pre-attached', 'attached-file', 'éattached', 'attached９', '报告附件在此', '> attached', '  > attached', 'hello\n--\nattached', '--  \nattached', '---\nattached']) {
    const input = { mode: 'reply', subject: '', bodyText, attachmentCount: 0 };
    record('attachment', bodyText, input, missingAttachment(input));
  }
  for (const mode of ['new', 'reply', 'replyAll', 'forward']) for (const attachmentCount of [0, 1]) {
    const input = { mode, subject: 'attached', bodyText: '', attachmentCount }; record('attachment', `subject-${mode}-${attachmentCount}`, input, missingAttachment(input));
  }
  for (const html of ['<p>Hello</p><blockquote><p>attached</p></blockquote>', '<p>Hello</p><p>--</p><p>attached</p>', '<p>attached &amp; ready</p>', '<p></p><ul><li>Words</li></ul>']) {
    const bodyText = htmlToText(html); const input = { mode: 'new', subject: '', bodyText, attachmentCount: 0 };
    record('authored', html, { html, ...input }, { bodyText, missing: missingAttachment(input), textHtml: textToHtml(bodyText) });
  }
  for (const timeZone of ['UTC', 'Europe/Vilnius', 'America/New_York']) for (const instant of ['2026-10-24T12:00:00.000Z', '2026-10-24T12:00:20.000Z', '2026-10-24T12:00:00.001Z']) for (const minutes of [0, 1, 5, 6, 1440]) {
    const now = Date.parse(instant); const plan = { kind: 'in', minutes };
    record('route', `${timeZone}-${instant}-${minutes}`, { plan, scheduleDraft: null, now, timeZone }, routeSend(plan, null, now, timeZone));
  }
  record('route', 'global-delay', { plan: null, scheduleDraft: null, now: Date.now(), timeZone: 'UTC' }, routeSend(null, null, Date.now(), 'UTC'));
  for (const [timeZone, localTime] of [['UTC', '2026-10-25T00:00'], ['Europe/Vilnius', '2026-03-29T03:30'], ['Europe/Vilnius', '2026-10-25T03:30'], ['America/New_York', '2026-03-08T02:30'], ['America/New_York', '2026-11-01T01:30']]) {
    const epoch = zonedTimeToEpoch(localTime, timeZone);
    record('time', `${timeZone}-${localTime}`, { localTime, timeZone, now: epoch }, { epoch, wall: wallClockAt(epoch, timeZone), past: isPastLocalTime(localTime, timeZone, epoch) });
    const draft = { localTime, tz: timeZone }; record('route', `absolute-${timeZone}-${localTime}`, { plan: { kind: 'at' }, scheduleDraft: draft, now: Date.now(), timeZone }, routeSend({ kind: 'at' }, draft, Date.now(), timeZone));
  }
  for (const input of [
    { replyTo: { _accountId: 'two' } }, { replyTo: { _srcAccountId: 'two' } }, { replyTo: { _accountId: 'gone' } },
    { initialData: { _accountId: 'two', _fromAddress: 'removed@example.test' } }, { initialData: { _accountId: 'gone' } },
    {}, { selectedAccountId: 'two', lastIdentity: { accountId: 'one', address: 'removed@example.test' } },
    { selectedAccountId: 'two', lastIdentity: { accountId: 'two', address: 'removed@example.test' } },
  ]) { const full = { accounts, activeAccountId: 'one', selectedAccountId: 'two', ...input }; record('identity', JSON.stringify(input), full, resolveInitialComposeIdentity(full)); }
  for (const state of [{}, { billingProfile: { hasSubscription: true, status: 'active' } }, { billingProfile: { hasSubscription: true, clientAccessGranted: false, premiumAccess: true, status: 'active' } }, { shareGrant: { expiresAt: '2026-10-26T00:00Z' } }, { shareGrant: { expiresAt: '2026-10-25T00:00Z' } }, { billingProfile: { hasSubscription: true, status: 'canceled', currentPeriodEnd: '2026-10-26T00:00Z' } }]) {
    useSettingsStore.setState({ shareGrant: null, ...state }); record('premium', JSON.stringify(state), { state, now: Date.now() }, hasPremiumAccess(state.billingProfile));
  }
  for (const forward of [false, true]) for (const quotedHtml of ['', '<p><strong>Original</strong></p><table><tr><td>raw</td></tr></table>']) {
    const body = '<p>typed</p>'; const wire = replyWireHtml(body, quotedHtml, forward); record('wire', `${forward}-${quotedHtml}`, { body, quotedHtml, forward }, { wire, split: splitWireHtml(wire) });
  }
  const fixture = { schemaVersion: 1, source: { snapshotCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), files: Object.fromEntries(sourceFiles.map(path => [path, sha(path)])), generatorSha256: sha(new URL(import.meta.url)), node: process.version, icu: process.versions.icu, zone: Intl.DateTimeFormat().resolvedOptions().timeZone, locale: 'en-US', clock: '2026-10-25T00:00:00.000Z', mocks: ['formatDateTime(value) = date:value; other date display helpers empty', 'fake UTC clock; real jsdom DOMParser and real RichTextEditor exports; no dev premium override'] }, accounts, settings, cases };
  if (process.env.MAILVAULT_GENERATE_COMPOSE_FIXTURE === '1') {
    console.log('COMPOSE_PREP_FIXTURE_BASE64_BEGIN'); console.log(Buffer.from(JSON.stringify(fixture, null, 2) + '\n').toString('base64')); console.log('COMPOSE_PREP_FIXTURE_BASE64_END');
  } else {
    const saved = JSON.parse(readFileSync('src-core/tests/fixtures/compose-prep-cases.json', 'utf8'));
    expect(fixture.cases).toEqual(saved.cases);
    expect(fixture.source.files).toEqual(saved.source.files);
    // The frozen hash names the exact capture revision. A later fixture-loader
    // fix must not rewrite its historical provenance or the golden bytes.
    expect(saved.source.generatorSha256).toBe('92b82dbca7598738205ce3779c93c7bae6751719d3c47ab7be90d903d8a20188');
  }
  vi.useRealTimers();
});
