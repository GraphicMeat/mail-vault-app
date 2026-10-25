// @vitest-environment jsdom
// Supplemental actual-JS evidence. Original 244-case corpus is immutable.
import { it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
vi.mock('../../../../src/utils/dateFormat', () => ({ formatDateTime: value => `date:${value}`, formatTime: () => '', formatDateOnly: () => '', formatDateLong: () => '', formatWeekdayShort: () => '' }));
import { computeReplyRecipients } from '../../../../src/utils/emailParser';
import { composeIdentities } from '../../../../src/utils/sendAsSuggestions';
import { buildQuoteBlocks } from '../../../../src/utils/replyQuote';
const sha = value => createHash('sha256').update(value).digest('hex');
const identityCases = [];
const base = () => ({ from: { address: 'owner@example.test' }, to: [{ address: 'owner@example.test' }, { address: 'friend@example.test' }], cc: [{ address: 'owner@example.test' }, { address: 'copy@example.test' }], bcc: [{ address: 'bcc-supplement@example.test' }], subject: 'Topic' });
const recordIdentity = (name, accounts, settings, picked, message, mode) => {
  const identities = composeIdentities(accounts, settings.sendAsAddresses, settings.aliases);
  if (picked && !identities.some(i => i.accountId === 'one' && i.address.toLowerCase() === picked.toLowerCase())) identities.push({ accountId: 'one', address: picked });
  identityCases.push({ name, input: { accounts, settings, picked, message, mode }, output: computeReplyRecipients(message, mode, identities.map(i => i.address)) });
};
for (const [label, char] of [['FEFF', '\ufeff'], ['0085', '\u0085']]) for (const side of ['prefix', 'suffix']) {
  const wrap = s => side === 'prefix' ? char + s : s + char;
  for (const source of ['login', 'default', 'alias', 'picked']) for (const mode of ['reply', 'replyAll']) {
    const address = wrap('owner@example.test');
    const accounts = [{ id: 'one', email: source === 'login' ? address : 'login@example.test' }];
    const settings = { sendAsAddresses: source === 'default' ? { one: address } : {}, aliases: source === 'alias' ? { one: [{ address }] } : {} };
    recordIdentity(`${label}-${side}-${source}-${mode}`, accounts, settings, source === 'picked' ? address : '', base(), mode);
  }
  for (const path of ['from', 'replyTo', 'to', 'cc']) for (const mode of ['reply', 'replyAll']) {
    const message = base();
    if (path === 'from') message.from.address = wrap('owner@example.test');
    if (path === 'replyTo') { message.from.address = 'outside@example.test'; message.replyTo = [{ address: wrap('owner@example.test') }]; }
    if (path === 'to' || path === 'cc') { message.from.address = 'outside@example.test'; message[path] = [{ address: wrap('owner@example.test') }, { address: 'friend@example.test' }]; }
    recordIdentity(`${label}-${side}-message-${path}-${mode}`, [{ id: 'one', email: 'owner@example.test' }], {}, '', message, mode);
  }
  const message = base(); message.from.address = wrap('J.ohn+tag@googlemail.com');
  recordIdentity(`${label}-${side}-gmail-fold`, [{ id: 'one', email: 'john@gmail.com' }], {}, '', message, 'reply');
}
const largeSpecs = [
  { name: 'context-65', count: 65, contextRepeat: 12, originalRepeat: 7, unit: 'x', mode: 'reply' },
  { name: 'context-257', count: 257, contextRepeat: 5, originalRepeat: 7, unit: 'x', mode: 'reply' },
  { name: 'original-over-2MiB-selected', count: 0, contextRepeat: 0, originalRepeat: 2097200, unit: 'x', mode: 'reply', selected: '<p>selected-only</p>' },
  { name: 'original-over-2MiB-forward', count: 0, contextRepeat: 0, originalRepeat: 2097200, unit: 'x', mode: 'forward', selected: '<p>selection-ignored</p>' },
  { name: 'aggregate-over-2MiB', count: 70, contextRepeat: 35000, originalRepeat: 7, unit: 'x', mode: 'reply' },
  { name: 'multibyte-escaped-text', count: 0, contextRepeat: 0, originalRepeat: 350000, unit: '界<&\n', mode: 'reply', text: true },
];
const largeMessage = (spec, index = null) => {
  const tag = index === null ? 'original' : `context-${index}`;
  const repeat = index === null ? spec.originalRepeat : spec.contextRepeat;
  const words = `START-${tag}:` + spec.unit.repeat(repeat) + `:END-${tag}`;
  return { from: { name: '<From & Name>', address: `${tag}@example.test` }, to: [{ address: 'owner@example.test' }], subject: `Subject <&> ${tag}`, date: `stamp-${tag}`, bcc: [{ address: 'bcc-large-sentinel@example.test' }], ...(spec.text ? { text: words } : { html: `<table style="color:red"><tr><td>${words}<img src="cid:logo"></td></tr></table>` }) };
};
it('freezes source-derived identity whitespace and complete large quote bytes', () => {
  const largeCases = largeSpecs.map(spec => {
    const message = largeMessage(spec);
    message._threadContext = Array.from({ length: spec.count }, (_, i) => largeMessage(spec, i));
    if (spec.selected !== undefined) message._selectedQuoteHtml = spec.selected;
    const blocks = buildQuoteBlocks(message, 'Original message');
    const output = { ...blocks, quotedHtml: spec.mode === 'forward' ? blocks.quotedHeaderHtml + blocks.fullQuotedBodyHtml : blocks.quotedHtml, fullOriginalHtml: blocks.quotedHeaderHtml + blocks.fullQuotedBodyHtml };
    const digests = Object.fromEntries(Object.entries(output).map(([key, value]) => [key, { bytes: Buffer.byteLength(value), sha256: sha(value) }]));
    expect(Object.values(output).join('')).not.toContain('bcc-large-sentinel');
    return { spec, inputBytes: Buffer.byteLength(JSON.stringify(message)), digests };
  });
  const paths = ['src/utils/emailParser.js', 'src/utils/ownAddresses.js', 'src/utils/emailIdentity.js', 'src/utils/sendAsSuggestions.js', 'src/utils/replyQuote.js', 'src/components/RichTextEditor.jsx'];
  const fixture = { schemaVersion: 1, source: { snapshotCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), files: Object.fromEntries(paths.map(path => [path, sha(readFileSync(path))])), generatorSha256: sha(readFileSync(new URL(import.meta.url))), node: process.version, icu: process.versions.icu, zone: Intl.DateTimeFormat().resolvedOptions().timeZone, mocks: ['formatDateTime(value)=date:value; real JS identity/recipient/quote/RichTextEditor exports', 'large bodies reconstructed from stored deterministic specs; digests are test evidence only'] }, identityCases, largeCases };
  const historical = JSON.parse(readFileSync('src-core/tests/fixtures/compose-prep-supplement.json', 'utf8'));
  if (process.env.MAILVAULT_GENERATE_COMPOSE_SUPPLEMENT === '1') {
    // Explicit historical capture must run at the recorded source tree.
    expect(fixture.source.files).toEqual(historical.source.files);
    console.log('COMPOSE_SUPPLEMENT_BASE64_BEGIN'); console.log(Buffer.from(JSON.stringify(fixture, null, 2) + '\n').toString('base64')); console.log('COMPOSE_SUPPLEMENT_BASE64_END');
  } else {
    const saved = JSON.parse(readFileSync('src-core/tests/fixtures/compose-prep-supplement.json', 'utf8'));
    expect(fixture.identityCases).toEqual(saved.identityCases); expect(fixture.largeCases).toEqual(saved.largeCases); for (const [path, hash] of Object.entries(saved.source.files)) expect(sha(execFileSync('git', ['show', `${saved.source.snapshotCommit}:${path}`]))).toBe(hash);
  }
});
