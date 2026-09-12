/*
 * Browser-only MailVault backend.
 *
 * This deliberately owns every mutable demo fact. The production React
 * components still talk through their normal API/native seams; the demo entry
 * swaps those seams for this deterministic session so no account, credential,
 * network, billing or telemetry request can escape the page.
 */

const ACCOUNT_IDS = [
  '7f7d5d80-4bd3-4f67-9a1a-1d1c00100001',
  '7f7d5d80-4bd3-4f67-9a1a-1d1c00100002',
  '7f7d5d80-4bd3-4f67-9a1a-1d1c00100003',
];
import { buildEnrichmentMessages } from './enrichmentFixtures.js';

const clone = value => typeof structuredClone === 'function'
  ? structuredClone(value)
  : JSON.parse(JSON.stringify(value));

// Backend rows expose account/custody getters for the production UI. Those
// runtime references do not belong in the browser workspace record; restore
// recreates them from the stable account id and preserves all message/MIME
// fields, including attachment bytes.
const serializeMessage = message => {
  const { account, custody, isArchived, isLocal, ...stored } = message;
  return clone(stored);
};

const key = (accountId, mailbox, uid) => `${accountId}|${mailbox}|${uid}`;

class DemoUnsupportedError extends Error {
  constructor(command) {
    super(`This demo cannot perform “${command}” in a browser. The desktop app performs it locally.`);
    this.name = 'DemoUnsupportedError';
    this.code = 'DEMO_UNSUPPORTED';
    this.command = command;
    this.simulated = false;
  }
}

const account = (id, name, email) => ({
  id, name, email, authType: 'password', password: 'demo-only',
  imapHost: 'demo.invalid', imapPort: 993, smtpHost: 'demo.invalid', smtpPort: 465,
  secure: true, sentFolder: 'Sent', demo: true,
});

const ACCOUNTS = Object.freeze([
  account(ACCOUNT_IDS[0], 'Prime Cut Studio', 'rowan@primecut.studio'),
  account(ACCOUNT_IDS[1], 'Rowan Marsh', 'rowan.marsh@gmail.com'),
  account(ACCOUNT_IDS[2], 'Studio Accounts', 'accounts@primecut.studio'),
]);

const MAILBOXES = Object.freeze([
  { path: 'INBOX', name: 'Inbox', delimiter: '/', flags: ['\\HasNoChildren'], specialUse: '\\Inbox' },
  { path: 'Sent', name: 'Sent', delimiter: '/', flags: ['\\HasNoChildren', '\\Sent'], specialUse: '\\Sent' },
  { path: 'Drafts', name: 'Drafts', delimiter: '/', flags: ['\\HasNoChildren', '\\Drafts'], specialUse: '\\Drafts' },
  { path: 'Archive', name: 'Archive', delimiter: '/', flags: ['\\HasNoChildren', '\\Archive'], specialUse: '\\Archive' },
  { path: 'Trash', name: 'Trash', delimiter: '/', flags: ['\\HasNoChildren', '\\Trash'], specialUse: '\\Trash' },
  { path: 'Clients', name: 'Clients', delimiter: '/', flags: [], children: [
    { path: 'Clients/Skewer', name: 'Skewer', delimiter: '/', flags: ['\\HasNoChildren'] },
    { path: 'Clients/Tenderloin', name: 'Tenderloin', delimiter: '/', flags: ['\\HasNoChildren'] },
  ] },
  { path: 'Suppliers', name: 'Suppliers', delimiter: '/', flags: ['\\HasNoChildren'] },
]);

const plain = ({ name, address }) => ({ name, address });
const html = text => `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:620px;line-height:1.6"><p>${text.replace(/\n/g, '</p><p>')}</p></div>`;
// A real one-page PDF keeps the attachment preview useful in a static demo.
// The previous zero-page placeholder made Chrome's PDF viewer reject it.
const DEMO_PDF_BASE64 = 'JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCAzMDAgMjAwXSAvQ29udGVudHMgNCAwIFIgL1Jlc291cmNlcyA8PCAvRm9udCA8PCAvRjEgNSAwIFIgPj4gPj4gPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCA0OCA+PgpzdHJlYW0KQlQgL0YxIDE4IFRmIDM2IDEyMCBUZCAoTWFpbFZhdWx0IGRlbW8pIFRqIEVUCmVuZHN0cmVhbQplbmRvYmoKNSAwIG9iago8PCAvVHlwZSAvRm9udCAvU3VidHlwZSAvVHlwZTEgL0Jhc2VGb250IC9IZWx2ZXRpY2EgPj4KZW5kb2JqCnhyZWYKMCA2CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAwOSAwMDAwMCBuIAowMDAwMDAwMDU4IDAwMDAwIG4gCjAwMDAwMDExNSAwMDAwMCBuIAowMDAwMDAyNDEgMDAwMDAgbiAKMDAwMDAwMzM2IDAwMDAwIG4gCnRyYWlsZXIKPDwgL1NpemUgNiAvUm9vdCAxIDAgUiA+PgpzdGFydHhyZWYKNDA2CiUlRU9GCg==';

function makeMessage({ accountId, mailbox = 'INBOX', uid, from, to = null, cc = [], bcc = [], subject, text, htmlContent = null, multipartAlternative = false, daysAgo = 0, dateOverride = null, unread = false, flagged = false, vault = false, server = true, attachment = null, attachments = [], threadId = null, inReplyTo = null, references = [], messageId = null }, sessionNow) {
  const date = dateOverride || new Date(sessionNow - daysAgo * 86400000).toISOString();
  const acct = ACCOUNTS.find(item => item.id === accountId);
  const resolvedMessageId = messageId || `<demo-${accountId}-${uid}@mailvault.demo>`;
  const recipients = to == null
    ? [plain({ name: acct.name, address: acct.email })]
    : (Array.isArray(to) ? to : String(to).split(',').map(address => plain({ name: '', address: address.trim() })).filter(item => item.address));
  const formatMimeAddress = item => item?.name
    ? `"${String(item.name).replace(/["\\\r\n]/g, '')}" <${item.address}>`
    : item?.address || '';
  const boundary = `demo-alt-${accountId}-${uid}`;
  const bodyMime = multipartAlternative && htmlContent
    ? [`Content-Type: multipart/alternative; boundary="${boundary}"`, '', `--${boundary}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: 8bit', '', text, `--${boundary}`, 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: 8bit', '', htmlContent, `--${boundary}--`]
    : ['Content-Type: text/plain; charset=UTF-8', '', text];
  const normalizedAttachments = [ ...(attachment ? [attachment] : []), ...attachments ].map(item => ({
    ...item,
    filename: item.filename || item.name,
    contentType: item.contentType || item.mimeType || 'application/octet-stream',
    content: item.mimeType === 'application/pdf' || item.contentType === 'application/pdf'
      ? DEMO_PDF_BASE64
      : item.contentBase64 || item.content,
  }));
  const normalizedAttachment = normalizedAttachments[0] ? {
    ...normalizedAttachments[0],
  } : null;
  const attachmentHeader = normalizedAttachments.length
    ? `X-MailVault-Demo-Attachments: ${btoa(unescape(encodeURIComponent(JSON.stringify(normalizedAttachments.map(({ content, ...item }) => item)))) )}`
    : null;
  const raw = [
    `From: ${formatMimeAddress(from)}`, `To: ${recipients.map(formatMimeAddress).join(', ')}`,
    ...(cc?.length ? [`Cc: ${cc.map(formatMimeAddress).join(', ')}`] : []),
    ...(bcc?.length ? [`Bcc: ${bcc.map(formatMimeAddress).join(', ')}`] : []),
    `Subject: ${subject}`,
    `Date: ${date}`, `Message-ID: ${resolvedMessageId}`,
    ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`] : []),
    ...(references.length ? [`References: ${references.join(' ')}`] : []),
    'MIME-Version: 1.0', ...(htmlContent && multipartAlternative ? [`X-MailVault-Demo-HTML: ${btoa(unescape(encodeURIComponent(htmlContent)))}`] : []),
    ...(attachmentHeader ? [attachmentHeader] : []), ...bodyMime,
  ].join('\r\n');
  return {
    id: `demo-${accountId}-${mailbox}-${uid}`, accountId, account: acct, mailbox, uid,
    _accountId: accountId, _mailbox: mailbox, _accountEmail: acct.email,
    from, to: recipients, cc, bcc, subject, text, html: htmlContent || html(text),
    snippet: text.split('\n')[0], date, internalDate: date, messageId: resolvedMessageId,
    flags: [ ...(unread ? [] : ['\\Seen']), ...(flagged ? ['\\Flagged'] : []) ],
    vaultFlags: vault ? ['archived', ...(unread ? [] : ['seen']), ...(flagged ? ['flagged'] : [])] : [],
    hasAttachments: normalizedAttachments.length > 0, attachments: normalizedAttachments,
    rawSource: raw, rawSourceBase64: btoa(unescape(encodeURIComponent(raw))),
    serverPresent: server, vaultPresent: vault, threadId, inReplyTo, references: [...references],
    _origin: vault ? 'local' : null, serverDeleted: false, serverAbsent: !server,
    get custody() { return this.serverPresent && this.vaultPresent ? 'both' : this.serverPresent ? 'server' : 'local-only'; },
    get isArchived() { return this.vaultPresent; }, get isLocal() { return this.vaultPresent; },
    source: server ? 'server' : 'local', localId: `${accountId}-${mailbox}-${uid}`,
  };
}

const STUDIO_SENDERS = [
  ['Mara Cole', 'mara@northstar.example'],
  ['Ivo Chen', 'ivo@skewer.example'],
  ['June Atelier', 'hello@juneatelier.example'],
  ['Lena Ortiz', 'lena@tenderloin.type'],
  ['Theo Park', 'theo@fieldnotes.example'],
  ['Mina Shah', 'mina@paperplane.example'],
  ['Owen Price', 'owen@quietsignal.example'],
  ['Sora Kim', 'sora@northstar.example'],
].map(([name, address]) => plain({ name, address }));

// Calendar dates keep the expanded fixture useful for Explorer and Insights:
// the primary Inbox spans five years and every month without drifting into the
// future as the browser session moves forward.
const calendarDate = (sessionNow, index) => {
  const current = new Date(sessionNow);
  const month = index % 12;
  let year = current.getUTCFullYear() - Math.floor(index / 12);
  if (year === current.getUTCFullYear() && month >= current.getUTCMonth()) year -= 1;
  const day = 3 + ((index * 7) % 24);
  if (year === current.getUTCFullYear() && month === current.getUTCMonth() && day >= current.getUTCDate()) year -= 1;
  return new Date(Date.UTC(year, month, day, 12, 15, 0)).toISOString();
};

const PRIMARY_INBOX_EXPANDED = [
  ['Spring campaign brief', 'Mara has the first pass ready for the spring launch. The audience notes are in the final paragraph.', null, '<demo-spring-001@mailvault.demo>'],
  ['A quieter homepage for May', 'I softened the headline and kept the case study above the fold. The new copy is ready to review.'],
  ['Colour tokens for the studio kit', 'The warm graphite and saffron tokens now share the same contrast ratio across the kit.'],
  ['Print slot confirmed for Thursday', 'The press has reserved the afternoon slot. Please send the approved proof before lunch.'],
  ['Notes from the client workshop', 'Three themes surfaced: fewer labels, more breathing room, and a clearer handoff at the end.'],
  ['The short list for photography', 'I narrowed the options to the window light set and the close crop. Both work with the new palette.'],
  ['Invoice routing question', 'Should the production invoice go to Studio Accounts or directly to the client contact?'],
  ['Copy edit: product story', 'The opening now starts with the customer problem instead of our process. It reads much more naturally.'],
  ['Packaging mockup feedback', 'The smaller mark holds up at postage size. I left two notes on the inside flap for the next round.', 'creative-review', '<demo-creative-001@mailvault.demo>'],
  ['Re: Packaging mockup feedback', 'Agreed on the smaller mark. I will update the dieline and send a clean proof this afternoon.', 'creative-review', '<demo-creative-002@mailvault.demo>', '<demo-creative-001@mailvault.demo>'],
  ['A fresh set of social crops', 'The square, portrait, and story crops are in the same folder and keep the subject centered.'],
  ['Monday production check-in', 'No blockers from print or type. The only open question is which paper stock gets the final sign-off.'],
  ['Typeface licence renewal reminder', 'The studio licence renews this month. I added the seat count and current project list below.'],
  ['Two ways to simplify the navigation', 'Option A groups by client; option B keeps the current order and adds a compact project index.'],
  ['The redline on page six', 'The legal note needs one sentence removed before this goes to the printer. Everything else is approved.'],
  ['Summer menu photography', 'The overhead set is warmer than the side set and gives the dishes a little more depth.'],
  ['A note about the new paper stock', 'The uncoated sample takes the dark green beautifully, although the small caption needs a touch more weight.'],
  ['Studio away day details', 'We have a table booked near the station and a loose plan for the afternoon walk.'],
  ['Approved: launch checklist', 'The checklist is signed off. I marked the press proof and analytics handoff as complete.'],
  ['A question about alt text', 'Could you describe the hands and the printed card rather than the setting? That gives screen readers the useful detail.'],
  ['The September release window', 'Tuesday morning is still the best option. I will hold the staging link until the final review.'],
  ['Deck for the partner review', 'The new first slide makes the business case clearer. The rest of the deck can stay as it is.'],
  ['A small fix to the contact sheet', 'The last two names were swapped. I corrected them and added the preferred pronunciation notes.'],
  ['Editorial calendar, next quarter', 'I placed the customer story in week two and left room for one timely announcement at month end.'],
  ['Photo usage confirmation', 'The photographer confirmed web and print usage for the selected images through the end of next year.', null, '<demo-usage-001@mailvault.demo>'],
  ['Re: photo usage confirmation', 'Perfect, thank you. I have added the usage line to the campaign record and sent it to the client.', 'usage-check', '<demo-usage-002@mailvault.demo>', '<demo-usage-001@mailvault.demo>'],
  ['The workshop handout is ready', 'The handout has fewer steps, bigger examples, and a blank page for notes at the back.'],
  ['Questions from the type team', 'They need the final language list and a decision on whether numerals use oldstyle figures.'],
  ['A practical backup checklist', 'I wrote a short checklist for before a client closes a project: exports, licences, proofs, and approvals.'],
  ['New hours for the shared studio', 'The front desk is staffed until seven on weekdays. Weekend access still needs a booking.'],
  ['The calm version of the launch email', 'This draft keeps the announcement direct and gives the reader one clear thing to do next.'],
  ['A note from the paper supplier', 'The next delivery is arriving two days early. They included a sample of the heavier cover stock.'],
  ['Client portal labels', 'I replaced “files” with “deliverables” and “notes” with “conversation” in the portal navigation.'],
  ['Holiday coverage plan', 'Mara will cover approvals on Tuesday, and I can pick up anything urgent on Thursday afternoon.'],
  ['A better way to show progress', 'The progress summary is easier to scan when completed work appears first and open questions stay grouped below.'],
  ['Final proof naming convention', 'The team agreed on client-project-version-date, which should keep old proofs from getting mixed into deliveries.', null, '<demo-proofs-001@mailvault.demo>'],
  ['Re: final proof naming convention', 'I updated the shared folder and renamed the two older proofs so search finds the current one first.', 'proofs', '<demo-proofs-002@mailvault.demo>', '<demo-proofs-001@mailvault.demo>'],
  ['A compact guide to the colour system', 'The guide now explains when to use tint, shade, and contrast instead of showing every token at once.'],
  ['The little details in the footer', 'I aligned the legal line with the content grid and gave the contact link a little more room.'],
  ['Planning the autumn case study', 'The interview is scheduled for next week. I drafted questions around the before-and-after decisions.'],
  ['A note for the developer handoff', 'The component states are documented alongside the examples so the implementation has one source of truth.'],
  ['The final list of launch partners', 'I checked each logo against the current agreement and removed the one whose usage window ended.'],
  ['A small accessibility review', 'Keyboard order is clean now, and the focus ring remains visible against both hero backgrounds.'],
  ['What changed in the October brief', 'The audience is narrower, the promise is more concrete, and the proof point moved to the first section.'],
  ['A useful reply from the printer', 'They can match the spot colour if we provide the swatch with the final PDF.'],
  ['The winter workshop invitation', 'I kept the invitation short and included the train times so people can decide quickly.'],
  ['A note on archive labels', 'The new labels describe the project stage rather than the file type, which makes old work much easier to find.'],
  ['The January planning board', 'I added the three confirmed projects and left the fourth column open for the spring brief.', null, '<demo-planning-001@mailvault.demo>'],
  ['Re: January planning board', 'The spring brief can take the open column. I will add its milestones after the client call.', 'planning', '<demo-planning-002@mailvault.demo>', '<demo-planning-001@mailvault.demo>'],
  ['A tidy handoff before the break', 'The source files, approvals, and usage notes are all together in the project folder.'],
  ['Notes from the winter review', 'The strongest work is still the simplest. I captured that principle in the first page of the review.'],
  ['A new rhythm for weekly updates', 'I suggest a short Monday note with decisions first, links second, and questions at the end.'],
  ['The March content map', 'The map connects each story to one audience question and leaves space for a timely studio note.'],
  ['A final question about the archive', 'Should completed projects keep their original client folder, or move to the shared archive after handoff?'],
  ['Ready for the next review', 'The latest pass is in the shared folder. I highlighted only the decisions that still need a response.'],
];

const SECONDARY_EXPANDED = [
  { account: 0, mailbox: 'Clients/Skewer', uid: 560, from: ['Skewer Press', 'print@skewer.example'], subject: 'Stock sample for the summer run', text: 'The new stock has a softer tooth and keeps the small caption legible.', vault: true, dateIndex: 60 },
  { account: 0, mailbox: 'Clients/Skewer', uid: 561, from: ['Ivo Chen', 'ivo@skewer.example'], subject: 'Proof table booked for Tuesday', text: 'The proof table is ready at ten. Bring the colour swatches and the signed cover note.', vault: true, dateIndex: 61, messageId: '<demo-skewer-001@mailvault.demo>' },
  { account: 0, mailbox: 'Clients/Skewer', uid: 562, from: ['Skewer Press', 'print@skewer.example'], subject: 'Re: Proof table booked for Tuesday', text: 'I have the swatches and will bring the revised crop marks.', vault: true, dateIndex: 62, threadId: 'skewer-proof', messageId: '<demo-skewer-002@mailvault.demo>', inReplyTo: '<demo-skewer-001@mailvault.demo>' },
  { account: 0, mailbox: 'Clients/Tenderloin', uid: 563, from: ['Lena Ortiz', 'lena@tenderloin.type'], subject: 'Type specimen delivery', text: 'The specimen is ready with the licence notes and alternate numeral styles.', vault: true, dateIndex: 63, messageId: '<demo-type-001@mailvault.demo>' },
  { account: 0, mailbox: 'Clients/Tenderloin', uid: 564, from: ['Tenderloin Type', 'studio@tenderloin.type'], subject: 'Re: Type specimen delivery', text: 'The alternate numerals look good. Please include both sets in the client package.', vault: true, dateIndex: 64, threadId: 'type-specimen', messageId: '<demo-type-002@mailvault.demo>', inReplyTo: '<demo-type-001@mailvault.demo>' },
  { account: 0, mailbox: 'Archive', uid: 565, from: ['June Atelier', 'hello@juneatelier.example'], subject: 'Archived spring campaign notes', text: 'The spring notes are complete and ready for reference during the autumn brief.', vault: true, server: false, dateIndex: 65 },
  { account: 0, mailbox: 'Archive', uid: 566, from: ['Theo Park', 'theo@fieldnotes.example'], subject: 'Old project handoff', text: 'A clean record of the decisions, approvals, and final delivery links.', vault: true, server: false, dateIndex: 66 },
  { account: 0, mailbox: 'Sent', uid: 567, from: ['Rowan Marsh', 'rowan@primecut.studio'], to: [plain({ name: 'Mara Cole', address: 'mara@northstar.example' })], subject: 'Re: Spring campaign brief', text: 'The direction is approved. I will send the updated brief after the client review.', vault: true, dateIndex: 0, threadId: 'spring-brief', messageId: '<demo-spring-002@mailvault.demo>', inReplyTo: '<demo-spring-001@mailvault.demo>' },
  { account: 0, mailbox: 'Suppliers', uid: 568, from: ['Paper Supply Co', 'orders@paper.example'], subject: 'Cover stock availability', text: 'The heavier cover stock is available for the next production run.', vault: false, dateIndex: 68, messageId: '<demo-paper-001@mailvault.demo>' },
  { account: 0, mailbox: 'Suppliers', uid: 569, from: ['Paper Supply Co', 'orders@paper.example'], subject: 'Re: Cover stock availability', text: 'Please hold ten sheets for the next proof while we confirm the final quantity.', vault: false, dateIndex: 69, threadId: 'paper-stock', messageId: '<demo-paper-002@mailvault.demo>', inReplyTo: '<demo-paper-001@mailvault.demo>' },
  { account: 0, mailbox: 'Clients/Skewer', uid: 570, from: ['Ivo Chen', 'ivo@skewer.example'], subject: 'The final press checklist', text: 'Bleed, stock, crop marks, and delivery labels are all checked.', vault: true, dateIndex: 70, attachment: { name: 'press-checklist.pdf', mimeType: 'application/pdf', size: 589, contentBase64: DEMO_PDF_BASE64 } },
  { account: 0, mailbox: 'Clients/Tenderloin', uid: 571, from: ['Tenderloin Type', 'studio@tenderloin.type'], subject: 'Licence seats updated', text: 'The seat count now matches the current team and the renewal date is recorded.', vault: false, dateIndex: 71 },
  { account: 1, mailbox: 'INBOX', uid: 330, from: ['Ida Marsh', 'ida.marsh@fastmail.example'], subject: 'Sunday walk and coffee', text: 'The weather looks kind. I found a route that ends near the little bakery.', vault: true, dateIndex: 72, messageId: '<demo-weekend-001@mailvault.demo>' },
  { account: 1, mailbox: 'INBOX', uid: 331, from: ['Brine & Board', 'bookings@brineandboard.com'], subject: 'Your table is ready to confirm', text: 'We can keep the window table until Thursday evening.', vault: false, dateIndex: 73 },
  { account: 1, mailbox: 'INBOX', uid: 332, from: ['Ida Marsh', 'ida.marsh@fastmail.example'], subject: 'Re: Sunday walk and coffee', text: 'That route sounds perfect. I will bring the camera and meet you by the bridge.', vault: true, dateIndex: 74, threadId: 'weekend', messageId: '<demo-weekend-002@mailvault.demo>', inReplyTo: '<demo-weekend-001@mailvault.demo>' },
  { account: 1, mailbox: 'INBOX', uid: 333, from: ['Grill Theory', 'hello@grilltheory.co'], subject: 'Workshop recipe notes', text: 'The recipe notes are attached to your booking and include the substitutions we discussed.', vault: true, dateIndex: 75, attachment: { name: 'recipe-notes.pdf', mimeType: 'application/pdf', size: 589, contentBase64: DEMO_PDF_BASE64 } },
  { account: 1, mailbox: 'INBOX', uid: 334, from: ['Nadia Wells', 'nadia@bookclub.example'], subject: 'Next month book choice', text: 'The group chose a short novel with a very good final chapter.', vault: false, dateIndex: 76 },
  { account: 1, mailbox: 'Archive', uid: 335, from: ['Ida Marsh', 'ida.marsh@fastmail.example'], subject: 'A note from the old flat', text: 'Found this while clearing the archive. It still made me laugh.', vault: true, server: false, dateIndex: 77 },
  { account: 1, mailbox: 'Sent', uid: 336, from: ['Rowan Marsh', 'rowan.marsh@gmail.com'], to: [plain({ name: 'Ida Marsh', address: 'ida.marsh@fastmail.example' })], subject: 'Re: Sunday walk and coffee', text: 'I will be there at ten. Looking forward to it.', vault: true, dateIndex: 78, threadId: 'weekend', messageId: '<demo-weekend-003@mailvault.demo>', inReplyTo: '<demo-weekend-002@mailvault.demo>' },
  { account: 1, mailbox: 'INBOX', uid: 337, from: ['Local Market', 'hello@market.example'], subject: 'Your Saturday order', text: 'The order is packed and will be ready at the collection desk.', vault: true, dateIndex: 79 },
  { account: 1, mailbox: 'INBOX', uid: 338, from: ['Ida Marsh', 'ida.marsh@fastmail.example'], subject: 'A recipe worth keeping', text: 'I wrote down the lemon and olive version before I forgot the proportions.', vault: true, dateIndex: 87 },
  { account: 2, mailbox: 'INBOX', uid: 430, from: ['Dario Vella', 'dario@rackandrind.com'], subject: 'Payment receipt for invoice 0119', text: 'The receipt is attached and the account is now marked paid.', vault: true, dateIndex: 80, messageId: '<demo-invoice-002@rackandrind.com>', attachment: { name: 'payment-receipt.pdf', mimeType: 'application/pdf', size: 589, contentBase64: DEMO_PDF_BASE64 } },
  { account: 2, mailbox: 'INBOX', uid: 431, from: ['Studio Bank', 'notices@studiobank.example'], subject: 'Monthly account notice', text: 'The monthly notice is available in your secure account archive.', vault: false, dateIndex: 81, messageId: '<demo-account-001@mailvault.demo>' },
  { account: 2, mailbox: 'INBOX', uid: 432, from: ['Dario Vella', 'dario@rackandrind.com'], subject: 'Re: Payment receipt for invoice 0119', text: 'Thanks for confirming. I have added the receipt to the project record.', vault: true, dateIndex: 82, threadId: 'invoice', messageId: '<demo-invoice-003@rackandrind.com>', inReplyTo: '<demo-invoice-002@rackandrind.com>' },
  { account: 2, mailbox: 'Archive', uid: 433, from: ['Butcher\'s Ledger', 'statements@butchersledger.co'], subject: 'July statement archive', text: 'The July statement is retained for the annual accounts review.', vault: true, server: false, dateIndex: 83 },
  { account: 2, mailbox: 'Sent', uid: 434, from: ['Studio Accounts', 'accounts@primecut.studio'], to: [plain({ name: 'Studio Bank', address: 'notices@studiobank.example' })], subject: 'Re: Monthly account notice', text: 'Thank you. We have filed the notice with the rest of the monthly records.', vault: true, dateIndex: 84, threadId: 'account-notice', messageId: '<demo-account-002@mailvault.demo>', inReplyTo: '<demo-account-001@mailvault.demo>' },
  { account: 2, mailbox: 'INBOX', uid: 435, from: ['Studio Bank', 'notices@studiobank.example'], subject: 'Security review reminder', text: 'Please review the account contact details before the end of the quarter.', vault: false, dateIndex: 85 },
  { account: 2, mailbox: 'INBOX', uid: 436, from: ['Dario Vella', 'dario@rackandrind.com'], subject: 'Accounts handoff complete', text: 'The account handoff is complete and all receipts are filed under the project.', vault: true, dateIndex: 86 },
  { account: 2, mailbox: 'INBOX', uid: 437, from: ['Studio Bank', 'notices@studiobank.example'], subject: 'Quarterly account summary', text: 'The quarterly summary is ready for the studio records and year-end review.', vault: false, dateIndex: 88 },
];

function seedMessages(sessionNow) {
  const [studio, personal, billing] = ACCOUNT_IDS;
  const hero = [
    makeMessage({ accountId: studio, uid: 201, from: plain({ name: 'Ana Brandt', address: 'ana@sizzlemedia.co' }), subject: 'Round three is ready for the client', text: 'The hero is warmer, the smoke is calmer, and the final artwork is attached.', daysAgo: 0, unread: true, vault: true, attachment: { name: 'round-three.pdf', mimeType: 'application/pdf', size: 589, contentBase64: DEMO_PDF_BASE64 }, threadId: 'launch', messageId: '<demo-launch-001@smokehouse.design>' }, sessionNow),
    makeMessage({ accountId: studio, uid: 202, from: plain({ name: 'MeatPad', address: 'release@meatpad.app' }), subject: 'Your weekly workspace digest', text: 'Four files changed since Monday. The release notes are ready to review.', daysAgo: 1, unread: true, vault: false }, sessionNow),
    makeMessage({ accountId: studio, uid: 203, from: plain({ name: 'Nell Okafor', address: 'nell@smokehouse.design' }), subject: 'Rack & Rind — launch campaign, round three', text: 'Can we get the final artwork to Skewer by Thursday? They print Friday.\n\nNell', daysAgo: 2, vault: true, threadId: 'launch', messageId: '<demo-launch-002@smokehouse.design>', inReplyTo: '<demo-launch-001@smokehouse.design>', references: ['<demo-launch-001@smokehouse.design>'] }, sessionNow),
    makeMessage({ accountId: studio, uid: 204, from: plain({ name: 'Rowan Marsh', address: 'rowan@primecut.studio' }), to: [plain({ name: 'Nell Okafor', address: 'nell@smokehouse.design' })], mailbox: 'Sent', subject: 'Re: Rack & Rind — launch campaign, round three', text: 'Taking a pass at the warmer hero now. I will send the final by Thursday.\n\nRowan', daysAgo: 2, vault: true, threadId: 'launch', inReplyTo: '<demo-launch-002@smokehouse.design>', references: ['<demo-launch-001@smokehouse.design>', '<demo-launch-002@smokehouse.design>'] }, sessionNow),
    makeMessage({ accountId: studio, uid: 205, from: plain({ name: 'Priya Raines', address: 'priya@tenderloin.type' }), subject: 'Brisket Sans — licence renews 4 September', text: 'Five seats are ready to renew. The invoice is attached for your records.', daysAgo: 4, vault: true, flagged: true, attachment: { name: 'invoice-0119.pdf', mimeType: 'application/pdf', size: 589, contentBase64: DEMO_PDF_BASE64 } }, sessionNow),
    makeMessage({ accountId: studio, uid: 206, from: plain({ name: "Butcher's Ledger", address: 'statements@butchersledger.co' }), subject: 'August statement — Prime Cut Studio', text: 'Your August statement is attached. The closing balance is unchanged.', daysAgo: 7, vault: false }, sessionNow),
    makeMessage({ accountId: studio, uid: 207, from: plain({ name: 'Cleaver Cloud', address: 'billing@cleavercloud.io' }), subject: 'Storage report: 18% remaining', text: 'Your workspace has 18% storage remaining. See the report for details.', daysAgo: 8, server: false, vault: true }, sessionNow),
    makeMessage({ accountId: studio, mailbox: 'Clients/Skewer', uid: 208, from: plain({ name: 'Skewer Press', address: 'print@skewer.example' }), subject: 'Proof notes for Friday run', text: 'The crop marks are clean. Please approve the stock before noon.', daysAgo: 46, vault: true, attachment: { name: 'proof.png', mimeType: 'image/png', size: 68, contentBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' } }, sessionNow),
    makeMessage({ accountId: studio, mailbox: 'Clients/Tenderloin', uid: 209, from: plain({ name: 'Tenderloin Type', address: 'studio@tenderloin.type' }), subject: 'Brand system handoff', text: 'The source package is in the shared vault, with the type licence notes.', daysAgo: 124, server: false, vault: true }, sessionNow),
    makeMessage({ accountId: personal, uid: 301, from: plain({ name: 'Brine & Board', address: 'bookings@brineandboard.com' }), subject: 'Saturday, 20:00 — the usual table', text: 'Held for four. The kitchen is doing the short rib again.', daysAgo: 0, unread: true, vault: true }, sessionNow),
    makeMessage({ accountId: personal, uid: 302, from: plain({ name: 'Ida Marsh', address: 'ida.marsh@fastmail.example' }), subject: 'Photos from the weekend', text: 'Sending the good ones only. The rest are of my thumb.', daysAgo: 3, vault: false }, sessionNow),
    makeMessage({ accountId: personal, uid: 303, from: plain({ name: 'Grill Theory', address: 'hello@grilltheory.co' }), subject: 'Your workshop place is confirmed', text: 'Saturday the 12th, 10:00. Bring an apron and low expectations.', daysAgo: 5, vault: true }, sessionNow),
    makeMessage({ accountId: personal, mailbox: 'Archive', uid: 304, from: plain({ name: 'Ida Marsh', address: 'ida.marsh@fastmail.example' }), subject: 'The house keys', text: 'Found them in the blue coat. Again.', daysAgo: 286, server: false, vault: true }, sessionNow),
    makeMessage({ accountId: billing, uid: 401, from: plain({ name: "Butcher's Ledger", address: 'statements@butchersledger.co' }), subject: 'August statement — Prime Cut Studio', text: 'Your August statement is attached. Closing balance is unchanged.', daysAgo: 1, vault: true, attachment: { name: 'statement-august.pdf', mimeType: 'application/pdf', size: 589, contentBase64: DEMO_PDF_BASE64 } }, sessionNow),
    makeMessage({ accountId: billing, uid: 402, from: plain({ name: 'Dario Vella', address: 'dario@rackandrind.com' }), subject: 'Invoice 0119 — scheduled for the 30th', text: 'Approved and scheduled for the 30th. Accounts have it.', daysAgo: 3, unread: true, vault: false, messageId: '<demo-invoice-001@rackandrind.com>' }, sessionNow),
    makeMessage({ accountId: billing, mailbox: 'Sent', uid: 403, from: plain({ name: 'Studio Accounts', address: 'accounts@primecut.studio' }), to: [plain({ name: 'Dario Vella', address: 'dario@rackandrind.com' })], subject: 'Re: Invoice 0119 — scheduled for the 30th', text: 'Thanks, Dario. We have the payment scheduled.', daysAgo: 2, vault: true, threadId: 'invoice', inReplyTo: '<demo-invoice-001@rackandrind.com>', references: ['<demo-invoice-001@rackandrind.com>'] }, sessionNow),
  ];
  const expandedInbox = PRIMARY_INBOX_EXPANDED.filter((_, index) => ![12, 13, 14, 15].includes(index)).map((item, index) => {
    const [subject, text, threadId, messageId, inReplyTo] = item;
    const sender = STUDIO_SENDERS[index % STUDIO_SENDERS.length];
    const vault = index % 4 !== 1;
    return makeMessage({ accountId: studio, uid: index + 1, from: sender, subject, text, dateOverride: calendarDate(sessionNow, inReplyTo ? Math.max(0, index - 3) : index), unread: index % 7 === 0, flagged: index % 13 === 0, vault, server: !vault || index % 11 !== 0, threadId: threadId || null, messageId: messageId || null, inReplyTo: inReplyTo || null, references: inReplyTo ? [inReplyTo] : [], attachment: index === 5 || index === 31 ? { name: index === 5 ? 'campaign-notes.pdf' : 'handoff.pdf', mimeType: 'application/pdf', size: 589, contentBase64: DEMO_PDF_BASE64 } : null }, sessionNow);
  });
  const expandedSecondary = SECONDARY_EXPANDED.map(item => makeMessage({
    accountId: ACCOUNT_IDS[item.account], mailbox: item.mailbox, uid: item.uid,
    from: plain({ name: item.from[0], address: item.from[1] }), to: item.to || null,
    subject: item.subject, text: item.text, dateOverride: calendarDate(sessionNow, item.inReplyTo ? Math.max(0, item.dateIndex - 3) : item.dateIndex),
    vault: item.vault, server: item.server !== false, threadId: item.threadId || null,
    messageId: item.messageId || null, inReplyTo: item.inReplyTo || null,
    references: item.inReplyTo ? [item.inReplyTo] : [], attachment: item.attachment || null,
  }, sessionNow));
  const enrichment = buildEnrichmentMessages({ sessionNow, accounts: ACCOUNTS, accountIds: ACCOUNT_IDS, makeMessage, plain, demoPdf: DEMO_PDF_BASE64, initialMessages: [...hero, ...expandedInbox, ...expandedSecondary] });
  const generated = [...expandedInbox, ...expandedSecondary, ...enrichment];
  const byMessageId = new Map([...hero, ...generated].map(message => [message.messageId, message]));
  // Keep generated conversations chronologically coherent even when their
  // broad calendar buckets cross a year boundary. Hero rows retain their
  // original dates; generated replies follow their parent by one hour.
  for (const message of [...expandedInbox, ...expandedSecondary]) {
    if (!message.inReplyTo) continue;
    const parent = byMessageId.get(message.inReplyTo);
    if (!parent) continue;
    const parentTime = Date.parse(parent.date);
    if (!Number.isFinite(parentTime)) continue;
    const nextTime = Math.min(parentTime + 3600000, sessionNow - 1000);
    message.date = new Date(nextTime).toISOString();
    message.internalDate = message.date;
    message.rawSource = message.rawSource.replace(/^Date: .*$/m, `Date: ${message.date}`);
    message.rawSourceBase64 = btoa(unescape(encodeURIComponent(message.rawSource)));
  }
  return [...hero, ...generated];
}

function header(message) {
  const { rawSource, rawSourceBase64, html: bodyHtml, text, ...rest } = message;
  return { ...clone(rest), html: bodyHtml, text, flags: [...message.flags], from: clone(message.from), to: clone(message.to), cc: [], bcc: [], attachments: message.attachments?.map(({ content, ...attachment }) => attachment) || [] };
}

const reviveMessage = stored => {
  const row = clone(stored);
  const acct = ACCOUNTS.find(item => item.id === row.accountId);
  if (!acct || !row.accountId || !row.mailbox || row.uid == null || !row.messageId) {
    throw new Error('Invalid demo message in persisted workspace');
  }
  row.account = acct;
  row._accountId = row.accountId;
  row._mailbox = row.mailbox;
  row._accountEmail = acct.email;
  row.flags = Array.isArray(row.flags) ? row.flags : [];
  row.vaultFlags = Array.isArray(row.vaultFlags) ? row.vaultFlags : [];
  row.attachments = Array.isArray(row.attachments) ? row.attachments : [];
  row.to = Array.isArray(row.to) ? row.to : [];
  row.cc = Array.isArray(row.cc) ? row.cc : [];
  row.bcc = Array.isArray(row.bcc) ? row.bcc : [];
  row.references = Array.isArray(row.references) ? row.references : [];
  Object.defineProperties(row, {
    custody: { enumerable: false, configurable: true, get() { return this.serverPresent && this.vaultPresent ? 'both' : this.serverPresent ? 'server' : 'local-only'; } },
    isArchived: { enumerable: false, configurable: true, get() { return this.vaultPresent; } },
    isLocal: { enumerable: false, configurable: true, get() { return this.vaultPresent; } },
  });
  return row;
};

export function createDemoBackend({ initialSettings = {} } = {}) {
  const sessionNow = Date.now();
  let messages = seedMessages(sessionNow);
  let mailboxList = clone(MAILBOXES);
  const accountMailboxAdds = new Map();
  let settings = clone(initialSettings);
  const listeners = new Map();
  const journal = [];
  let pendingOperation = null;
  let migrationState = null;
  const timeCapsules = new Map();
  const capsuleInitialized = new Set();
  let snapshotSeq = 0;
  let capsuleSeq = 0;
  let syncTicket = 0;
  const syncTickets = new Map();
  const snapshots = new Map();
  const builtMimes = new Map();
  const learning = new Map();
  const classificationOverrides = new Map();
  let externalBackupPath = null;

  const emit = (event, payload) => { for (const callback of listeners.get(event) || []) callback({ payload }); };
  const visible = (accountId, mailbox) => messages.filter(message => message.accountId === accountId && message.mailbox === mailbox && message.serverPresent);
  const local = (accountId, mailbox) => messages.filter(message => message.accountId === accountId && message.mailbox === mailbox && message.vaultPresent);
  const find = ({ accountId, mailbox, uid }) => messages.find(message => message.accountId === accountId && message.mailbox === mailbox && Number(message.uid) === Number(uid));
  const paramsAccountId = args => args.params?.accountId || args.accountId || null;
  const classify = row => /@newsletter\.example$/i.test(row.from?.address || '') || /digest|newsletter|weekly/i.test(row.subject)
    ? 'newsletter'
    : /invoice|statement|billing|payment/i.test(row.subject) ? 'transactional' : row.accountId === ACCOUNT_IDS[1] ? 'personal' : 'work';
  const classificationFor = row => {
    const override = classificationOverrides.get(row.messageId) || {};
    return { category: override.category || classify(row), action: override.action || (/invoice|statement|billing/i.test(row.subject) ? 'archive' : /digest|newsletter|weekly/i.test(row.subject) ? 'archive' : 'keep'), importance: override.importance || (row.flags.includes('\\Flagged') ? 'high' : 'normal') };
  };
  const mailboxPaths = (forAccount = null) => {
    const paths = [];
    const walk = nodes => (nodes || []).forEach(node => { paths.push(node.path); walk(node.children); });
    walk(mailboxList); return paths;
  };
  // Native LIST returns a flat path list. The renderer derives disclosure
  // children from those paths; returning the seed's nested children here
  // silently drops them in the real mailbox tree.
  const accountMailboxes = forAccount => {
    const flat = [];
    const walk = nodes => (nodes || []).forEach(node => {
      const { children, ...mailbox } = node;
      flat.push(mailbox);
      walk(children);
    });
    walk(mailboxList);
    return [...flat, ...(accountMailboxAdds.get(forAccount) || [])];
  };
  const unsupported = command => { throw new DemoUnsupportedError(command); };
  const downloadBrowserFile = (filename, content, type) => {
    if (typeof window === 'undefined' || !window.document || typeof Blob === 'undefined') return;
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const link = window.document.createElement('a');
    link.href = url; link.download = filename; link.rel = 'noopener';
    link.style.display = 'none';
    window.document.body?.appendChild(link);
    link.click();
    // Keep the object URL alive long enough for browser download managers to
    // consume it. Removing the anchor also avoids leaving hidden controls in
    // the visitor's document after repeated demo exports.
    setTimeout(() => { link.remove(); URL.revokeObjectURL(url); }, 1000);
  };
  const mimeAddressList = value => String(value || '').split(',').map(part => {
    const match = part.trim().match(/^(.*?)\s*<([^>]+)>$/);
    return plain({ name: (match ? match[1] : '').trim().replace(/^"|"$/g, ''), address: (match ? match[2] : part).trim() });
  }).filter(item => item.address);
  const parseMime = raw => {
    const value = String(raw || '');
    const headerValue = name => value.match(new RegExp(`^${name}:\\s*(.+)$`, 'mi'))?.[1]?.trim() || '';
    const separator = value.match(/\r?\n\r?\n/);
    let body = separator ? value.slice((separator.index || 0) + separator[0].length) : '';
    const htmlHeader = headerValue('X-MailVault-Demo-HTML');
    const attachmentsHeader = headerValue('X-MailVault-Demo-Attachments');
    let htmlBody = null;
    let attachmentList = [];
    try { htmlBody = htmlHeader ? decodeURIComponent(escape(atob(htmlHeader))) : null; } catch { htmlBody = null; }
    try {
      attachmentList = attachmentsHeader
        ? JSON.parse(decodeURIComponent(escape(atob(attachmentsHeader)))).map(item => ({ ...item, content: item.content || item.contentBase64 || null }))
        : [];
    } catch { attachmentList = []; }
    const contentType = headerValue('Content-Type');
    const boundary = contentType.match(/boundary="?([^";]+)"?/i)?.[1];
    if (boundary) {
      const escapedBoundary = boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const plainPart = body.match(new RegExp(`Content-Type:\\s*text/plain[^\\r\\n]*\\r?\\n(?:Content-Transfer-Encoding:[^\\r\\n]*\\r?\\n)?\\r?\\n([\\s\\S]*?)\\r?\\n--${escapedBoundary}`, 'i'));
      const htmlPart = body.match(new RegExp(`Content-Type:\\s*text/html[^\\r\\n]*\\r?\\n(?:Content-Transfer-Encoding:[^\\r\\n]*\\r?\\n)?\\r?\\n([\\s\\S]*?)\\r?\\n--${escapedBoundary}`, 'i'));
      if (plainPart) body = plainPart[1];
      if (htmlPart) htmlBody = htmlPart[1];
    }
    return { from: mimeAddressList(headerValue('From'))[0] || plain({ name: 'Demo sender', address: 'demo@mailvault.demo' }), to: mimeAddressList(headerValue('To')), cc: mimeAddressList(headerValue('Cc')), bcc: mimeAddressList(headerValue('Bcc')), subject: headerValue('Subject') || '(No subject)', date: headerValue('Date'), messageId: headerValue('Message-ID'), text: body, html: htmlBody, attachments: attachmentList };
  };
  const buildMime = (accountId, email, messageId) => {
    const sender = ACCOUNTS.find(item => item.id === accountId) || ACCOUNTS[0];
    const id = messageId || `<demo-compose-${Date.now()}-${Math.random().toString(36).slice(2)}@mailvault.demo>`;
    const htmlValue = email.html || html(email.text || '');
    const raw = [
      `From: ${sender.email}`, `To: ${email.to || ''}`, ...(email.cc ? [`Cc: ${email.cc}`] : []), ...(email.bcc ? [`Bcc: ${email.bcc}`] : []),
      `Subject: ${email.subject || ''}`, `Date: ${new Date().toISOString()}`, `Message-ID: ${id}`,
      ...(email.inReplyTo ? [`In-Reply-To: ${email.inReplyTo}`] : []), ...(email.references ? [`References: ${email.references}`] : []),
      `X-MailVault-Demo-HTML: ${btoa(unescape(encodeURIComponent(htmlValue)))}`,
      ...(email.attachments?.length ? [`X-MailVault-Demo-Attachments: ${btoa(unescape(encodeURIComponent(JSON.stringify(email.attachments))))}`] : []),
      'Content-Type: text/plain; charset=UTF-8', '', email.text || '',
    ].join('\r\n');
    return { rawBase64: btoa(unescape(encodeURIComponent(raw))), messageId: id, rawSize: raw.length };
  };

  const exportState = () => ({
    schemaVersion: 1,
    seedVersion: 'demo-300-v1',
    messages: messages.map(serializeMessage),
    mailboxList: clone(mailboxList),
    accountMailboxAdds: [...accountMailboxAdds.entries()].map(([id, rows]) => [id, clone(rows)]),
    settings: clone(settings),
    journal: clone(journal),
    migrationState: clone(migrationState),
    timeCapsules: [...timeCapsules.entries()].map(([id, value]) => [id, clone(value)]),
    capsuleInitialized: [...capsuleInitialized],
    snapshotSeq,
    capsuleSeq,
    snapshots: [...snapshots.entries()].map(([id, rows]) => [id, rows.map(serializeMessage)]),
    learning: [...learning.entries()].map(([id, value]) => [id, clone(value)]),
    classificationOverrides: [...classificationOverrides.entries()].map(([id, value]) => [id, clone(value)]),
    externalBackupPath,
  });

  const restoreState = stored => {
    if (!stored || stored.schemaVersion !== 1 || stored.seedVersion !== 'demo-300-v1' || !Array.isArray(stored.messages)) {
      throw new Error('Incompatible demo workspace');
    }
    const restoredMessages = stored.messages.map(reviveMessage);
    // A row with neither copy is a durable tombstone: it records a permanent
    // server delete so a later mailbox refresh cannot resurrect the message.
    if (!restoredMessages.length) {
      throw new Error('Invalid demo workspace messages');
    }
    messages = restoredMessages;
    mailboxList = Array.isArray(stored.mailboxList) ? clone(stored.mailboxList) : clone(MAILBOXES);
    accountMailboxAdds.clear();
    for (const [id, rows] of stored.accountMailboxAdds || []) {
      if (ACCOUNT_IDS.includes(id) && Array.isArray(rows)) accountMailboxAdds.set(id, clone(rows));
    }
    settings = stored.settings && typeof stored.settings === 'object' ? clone(stored.settings) : clone(initialSettings);
    journal.length = 0;
    if (Array.isArray(stored.journal)) journal.push(...clone(stored.journal));
    migrationState = stored.migrationState ? clone(stored.migrationState) : null;
    timeCapsules.clear();
    for (const [id, value] of stored.timeCapsules || []) timeCapsules.set(id, clone(value));
    capsuleInitialized.clear();
    for (const id of stored.capsuleInitialized || []) capsuleInitialized.add(id);
    snapshots.clear();
    for (const [id, rows] of stored.snapshots || []) snapshots.set(id, (rows || []).map(reviveMessage));
    learning.clear();
    for (const [id, value] of stored.learning || []) learning.set(id, clone(value));
    classificationOverrides.clear();
    for (const [id, value] of stored.classificationOverrides || []) classificationOverrides.set(id, clone(value));
    snapshotSeq = Number.isFinite(stored.snapshotSeq) ? stored.snapshotSeq : 0;
    capsuleSeq = Number.isFinite(stored.capsuleSeq) ? stored.capsuleSeq : 0;
    externalBackupPath = typeof stored.externalBackupPath === 'string' ? stored.externalBackupPath : null;
    // Sync tickets, MIME staging, listeners and pending operations are all
    // intentionally session-only. A reload must never send or resume work.
    pendingOperation = null;
    syncTickets.clear();
    syncTicket = 0;
    builtMimes.clear();
    emit('demo:state', { type: 'restored' });
  };

  const invoke = async (command, args = {}) => {
    const accountId = args.accountId || args.account?.id;
    const mailbox = args.mailbox || 'INBOX';
    switch (command) {
      case 'read_settings_json': return JSON.stringify(settings);
      case 'write_settings_json': settings = JSON.parse(args.data || '{}'); emit('demo:state', { type: 'settings' }); return null;
      case 'get_app_data_dir': return '/demo/app-data';
      case 'get_credentials': return { status: 'granted', credentials: Object.fromEntries(ACCOUNTS.map(item => [item.id, JSON.stringify(item)])) };
      case 'demo_emit_event': emit(args.event, args.payload); return null;
      case 'daemon_rpc': {
        const method = args.method;
        if (method === 'daemon.heartbeat') return { alive: true, version: 'browser-demo', uptime_secs: 0, online: true, simulated: true };
        if (method === 'daemon.status') return { version: 'browser-demo', uptime_secs: 0, data_dir: 'in-memory browser session', simulated: true };
        if (method === 'contacts_index.get') {
          const ids = Array.isArray(args.params?.accountIds) && args.params.accountIds.length ? args.params.accountIds : ACCOUNT_IDS;
          return Object.fromEntries(ids.map(id => {
            const counts = new Map();
            messages.filter(row => row.accountId === id && (row.serverPresent || row.vaultPresent)).forEach(row => {
              for (const contact of [row.from, ...(row.to || []), ...(row.cc || [])]) {
                if (!contact?.address) continue;
                const current = counts.get(contact.address) || { address: contact.address, name: contact.name || '', lastSeen: Date.parse(row.date) || sessionNow, count: 0 };
                current.count += 1; current.lastSeen = Math.max(current.lastSeen, Date.parse(row.date) || sessionNow); if (!current.name && contact.name) current.name = contact.name;
                counts.set(contact.address, current);
              }
            });
            return [id, [...counts.values()].sort((a, b) => b.count - a.count)];
          }));
        }
        if (method === 'sync.now') {
          const syncParams = args.params || {};
          const syncAccountId = syncParams.account?.id || syncParams.accountId || ACCOUNT_IDS[0];
          const syncMailbox = syncParams.mailbox || 'INBOX';
          const ticket = ++syncTicket;
          syncTickets.set(ticket, { accountId: syncAccountId, mailbox: syncMailbox });
          emit('sync:event', { type: 'finished', ticket, simulated: true });
          return { ticket, started: true, account_id: syncAccountId, mailbox: syncMailbox, simulated: true };
        }
        if (method === 'sync.wait') {
          const ticket = Number(args.params?.ticket);
          if (!Number.isFinite(ticket) || !syncTickets.has(ticket)) throw new DemoUnsupportedError('sync.wait:unknown-ticket');
          const sync = syncTickets.get(ticket);
          syncTickets.delete(ticket);
          return { account_id: sync.accountId, mailbox: sync.mailbox, new_emails: 0, total_emails: visible(sync.accountId, sync.mailbox).length, success: true };
        }
        if (method === 'sync.status') return { status: 'idle', simulated: true };
        if (method === 'sync.watch' || method === 'sync.unwatch') return { success: true, simulated: true };
        if (method === 'sync.events') {
          const timeoutMs = Math.min(25000, Math.max(1, Number(args.params?.timeoutMs ?? args.timeoutMs ?? 25000)));
          // Keep the scheduler's long poll asynchronous. Resolving synchronously
          // makes its while-loop monopolise the browser microtask queue.
          await new Promise(resolve => setTimeout(resolve, timeoutMs));
          return { gen: Number(args.params?.since ?? args.since ?? 0), changes: [], simulated: true };
        }
        if (method === 'classification.summary') {
          const rows = messages.filter(row => !paramsAccountId(args) || row.accountId === paramsAccountId(args));
          const byCategory = { newsletter: 0, promotional: 0, notification: 0, transactional: 0, personal: 0, work: 0, 'spam-likely': 0 };
          const byAction = {};
          rows.forEach(row => { const result = classificationFor(row); byCategory[result.category] = (byCategory[result.category] || 0) + 1; byAction[result.action] = (byAction[result.action] || 0) + 1; });
          return { total: rows.length, classified: rows.length, by_category: byCategory, by_action: byAction, by_importance: { normal: rows.length }, simulated: true };
        }
        if (method === 'classification.results') {
          const rows = messages.filter(row => !paramsAccountId(args) || row.accountId === paramsAccountId(args));
          return rows.filter(row => row.serverPresent || row.vaultPresent).map(row => {
            const override = classificationOverrides.get(row.messageId) || {};
            const result = classificationFor(row);
            return { ...header(row), from: row.from?.address || row.from?.name || '', messageId: row.messageId, classification: { ...result, confidence: 0.95, classified_at: row.date, model_used: 'demo-rules', source: override.category ? 'override' : 'demo-rules' } };
          });
        }
        if (method === 'classification.run' || method === 'classification.reclassify_all') return { started: true, simulated: true };
        if (method === 'classification.cancel') return { cancelled: true, simulated: true };
        if (method === 'classification.status') return { status: 'Idle', classified: messages.filter(row => row.serverPresent || row.vaultPresent).length, total: messages.length, skipped_by_rules: 0, queue_depth: 0, phase: 'idle', simulated: true };
        if (method === 'classification.override') {
          const override = { category: args.params?.category, action: args.params?.action, importance: args.params?.importance };
          classificationOverrides.set(args.params?.messageId, override);
          emit('demo:state', { type: 'classification' });
          return { messageId: args.params?.messageId, ...override, simulated: true };
        }
        if (method === 'learning.load') return clone(learning.get(paramsAccountId(args)) || { rules: [], corrections: [], stats: { totalClassified: messages.length, totalCorrected: 0, accuracyRate: 1 } });
        if (method === 'learning.save') { learning.set(paramsAccountId(args), clone(args.params?.feedback || args.feedback || { rules: [], corrections: [], stats: {} })); emit('demo:state', { type: 'learning' }); return { success: true, simulated: true }; }
        if (method.startsWith('snapshot.')) {
          const snapshotAccountId = args.params?.accountId || ACCOUNT_IDS[0];
          const snapshotManifest = (requestedMailboxes = null) => {
            const allowed = Array.isArray(requestedMailboxes) && requestedMailboxes.length ? new Set(requestedMailboxes) : null;
            const snapshotRows = messages.filter(row => row.accountId === snapshotAccountId && row.vaultPresent && (!allowed || allowed.has(row.mailbox)));
            return { account_id: snapshotAccountId, account_email: ACCOUNTS.find(row => row.id === snapshotAccountId)?.email, timestamp: new Date().toISOString(), mailboxes: Object.fromEntries([...new Set(snapshotRows.map(row => row.mailbox))].map(path => [path, { total_emails: snapshotRows.filter(row => row.mailbox === path).length, emails: snapshotRows.filter(row => row.mailbox === path).map(row => ({ uid: row.uid, subject: row.subject, from: clone(row.from), date: row.date, flags: [...row.flags], size: row.text.length })) }])) };
          };
          const keyPrefix = `${snapshotAccountId}|`;
          if (method === 'snapshot.list') {
            if (!capsuleInitialized.has(snapshotAccountId)) { timeCapsules.set(`${keyPrefix}demo-time-capsule.json`, snapshotManifest()); capsuleInitialized.add(snapshotAccountId); emit('demo:state', { type: 'time-capsule' }); }
            return [...timeCapsules.entries()].filter(([key]) => key.startsWith(keyPrefix)).map(([key, value]) => ({ timestamp: value.timestamp, filename: key.slice(keyPrefix.length), size_bytes: JSON.stringify(value).length, total_emails: Object.values(value.mailboxes).reduce((total, box) => total + box.total_emails, 0), mailbox_count: Object.keys(value.mailboxes).length, simulated: true })).sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
          }
          if (method === 'snapshot.load') {
            const filename = args.params?.filename || 'demo-time-capsule.json';
            const loaded = timeCapsules.get(`${keyPrefix}${filename}`);
            if (!loaded) throw new DemoUnsupportedError(`snapshot:${filename} is no longer available`);
            return clone(loaded);
          }
          if (method === 'snapshot.delete') { timeCapsules.delete(`${keyPrefix}${args.params?.filename}`); emit('demo:state', { type: 'time-capsule' }); return { deleted: true, simulated: true }; }
          const filename = `demo-time-capsule-${++capsuleSeq}.json`;
          const manifest = snapshotManifest(args.params?.mailboxes); timeCapsules.set(`${keyPrefix}${filename}`, manifest); capsuleInitialized.add(snapshotAccountId); emit('demo:state', { type: 'time-capsule' });
          return { timestamp: manifest.timestamp, filename, size_bytes: JSON.stringify(manifest).length, total_emails: Object.values(manifest.mailboxes).reduce((total, box) => total + box.total_emails, 0), mailbox_count: Object.keys(manifest.mailboxes).length, simulated: true };
        }
        throw new DemoUnsupportedError(`daemon:${method || 'unknown'}`);
      }
      case 'take_pending_mailto': return null;
      case ['send', 'notification'].join('_'): return { success: true, simulated: true };
      case 'check_running_from_dmg': return false;
      case 'read_logs': return '[demo] MailVault browser session — no native logs';
      case 'clear_logs': return { success: true, simulated: true };
      case 'op_journal_read': return clone(journal);
      case 'op_journal_queue': { const entry = { ...(args.entry || {}), id: journal.length + 1, at: sessionNow }; journal.push(entry); emit('demo:state', { type: 'journal' }); return entry.id; }
      case 'op_journal_clear': {
        const uids = new Set(args.uids || []);
        for (let index = journal.length - 1; index >= 0; index -= 1) {
          const entry = journal[index];
          if (entry.op === args.op && entry.accountId === args.accountId && entry.mailbox === args.mailbox && entry.uids?.some(uid => uids.has(uid))) journal.splice(index, 1);
        }
        emit('demo:state', { type: 'journal' });
        return null;
      }
      case 'read_pending_operation': return pendingOperation;
      case 'save_pending_operation': pendingOperation = args.operation || null; return null;
      case 'clear_pending_operation': pendingOperation = null; return null;
      case 'get_migration_state': return migrationState;
      case 'clear_migration_state_cmd': migrationState = null; return null;
      case 'maildir_migrate_json_to_eml': case 'maildir_migrate_email_dirs': return { migrated: 0, skipped: 0, simulated: true };
      case 'maildir_repair_generation': return { repaired: false, simulated: true };
      case 'imap_fetch_changed_flags': return { changes: [] };
      case 'vault_apply_flags': {
        const changes = args.changes || [];
        for (const change of changes) {
          const row = find({ accountId, mailbox, uid: change.uid });
          if (row?.vaultPresent) {
            row.flags = [...(change.flags || row.flags)];
            const markers = (row.vaultFlags || []).filter(flag => flag === 'archived' || flag === 'draft');
            const mirrored = row.flags.map(flag => ({ '\\Seen': 'seen', '\\Flagged': 'flagged', '\\Answered': 'replied' }[flag])).filter(Boolean);
            row.vaultFlags = [...new Set([...markers, ...mirrored])];
          }
        }
        emit('demo:state', { type: 'flags' });
        return { renamed: changes.length, mirrored: 0, index_patched: changes.length, sidecars_patched: changes.length, simulated: true };
      }
      case 'backup_scan_uids': {
        if (!externalBackupPath) return null;
        const scanAccountId = accountId || ACCOUNTS.find(item => item.email === args.email)?.id;
        return messages.filter(row => row.accountId === scanAccountId && row.mailbox === mailbox && row.vaultPresent).map(row => row.uid);
      }
      case 'backup_get_external_location': return externalBackupPath ? { path: externalBackupPath, displayPath: externalBackupPath, status: 'ready', simulated: true } : null;
      case 'backup_validate_external_location': return { status: 'simulated', displayPath: 'Browser session backup', lastValidatedAt: sessionNow, simulated: true };
      case 'backup_save_external_location': externalBackupPath = args.path || args.location || 'browser-downloads'; emit('demo:state', { type: 'backup-location' }); return { status: 'ready', path: externalBackupPath, displayPath: externalBackupPath, lastValidatedAt: sessionNow, simulated: true };
      case 'backup_clear_external_location': externalBackupPath = null; emit('demo:state', { type: 'backup-location' }); return null;
      case 'backup_migrate_legacy_path': return { status: 'simulated', displayPath: 'Browser session backup', lastValidatedAt: sessionNow, simulated: true };
      case 'backup_run_account': {
        const accountRows = messages.filter(row => row.accountId === args.accountId && row.serverPresent);
        accountRows.forEach(row => { row.vaultPresent = true; row.vaultFlags = [...new Set([...(row.vaultFlags || []), 'archived'])]; row._origin = row._origin || 'local'; row.source = row.source || 'local'; });
        emit('demo:state', { type: 'backup', accountId: args.accountId });
        return { success: true, status: 'complete', copied: accountRows.length, emails_backed_up: accountRows.length, simulated: true };
      }
      case 'backup_status': {
        const accountRows = messages.filter(row => !accountId || row.accountId === accountId);
        // Coverage compares the server inventory with matching local copies.
        // Local-only mail is valuable, but it is not part of this backup run;
        // counting it in `total_app` makes a healthy percentage exceed 100%.
        const serverRows = accountRows.filter(row => row.serverPresent);
        const backedRows = serverRows.filter(row => row.vaultPresent);
        const folders = [...new Set(accountRows.map(row => row.mailbox))].map(path => {
          const folderServer = serverRows.filter(row => row.mailbox === path);
          const folderBacked = backedRows.filter(row => row.mailbox === path);
          return { path, name: path.split('/').pop(), server_count: folderServer.length, app_count: folderBacked.length, external_count: externalBackupPath ? folderBacked.length : 0, children: [] };
        });
        return { folders, total_server: serverRows.length, total_app: backedRows.length, total_external: externalBackupPath ? backedRows.length : 0, external_available: !!externalBackupPath, status: 'idle', copied: backedRows.length, total: serverRows.length, simulated: true };
      }
      case 'backup_verify': return { folders: [], total_server: 0, total_app: messages.filter(row => row.vaultPresent).length, total_external: 0, external_available: false, simulated: true };
      case 'backup_cancel': return { cancelled: true, simulated: true };
      case 'preview_notification_sound': return { success: true, simulated: true };
      case 'get_transfer_stats': {
        const stats = {};
        for (const item of ACCOUNTS) {
          const days = {}; for (let index = 0; index < 7; index += 1) { const date = new Date(sessionNow - index * 86400000).toISOString().slice(0, 10); days[date] = { down: 175000 + index * 10000, up: 12000 + index * 1000 }; }
          stats[item.id] = { today: { down: 245000, up: 18000 }, week: { down: 1240000, up: 98000 }, month: { down: 5400000, up: 360000 }, year: { down: 44000000, up: 3200000 }, days };
        }
        return { accounts: args.accountId ? { [args.accountId]: stats[args.accountId] } : stats, simulated: true };
      }
      case 'vault_get_status': return { status: 'ready', displayPath: 'Browser demo vault', missing: false, platform: 'browser', simulated: true };
      case 'count_local_folder': return { count: local(accountId, mailbox).length, simulated: true };
      case 'maildir_orphan_stats': return { count: 0, bytes: 0 };
      case 'maildir_purge_orphans': return { removed: 0, bytes: 0, simulated: true };
      case 'imap_get_mailboxes': case 'list_mailboxes': return { mailboxes: clone(accountMailboxes(accountId)) };
      case 'imap_get_emails': {
        const rows = visible(accountId, mailbox).sort((a, b) => b.uid - a.uid);
        const limit = args.limit || 200;
        return { emails: rows.slice(0, limit).map(header), total: rows.length };
      }
      case 'imap_get_emails_range': {
        const rows = visible(accountId, mailbox).sort((a, b) => b.uid - a.uid);
        return { emails: rows.slice(args.startIndex || 0, (args.endIndex || rows.length) + 1).map(header), total: rows.length };
      }
      case 'imap_check_mailbox_status': {
        const rows = visible(accountId, mailbox); const max = rows.reduce((highest, row) => Math.max(highest, row.uid), 0);
        return { exists: rows.length, uidValidity: 1, uidNext: max + 1, highestModseq: max + 1 };
      }
      case 'imap_folder_status': return (args.mailboxes || []).map(path => { const rows = visible(accountId, path); return { path, messages: rows.length, unseen: rows.filter(row => !row.flags.includes('\\Seen')).length, uidNext: rows.reduce((max, row) => Math.max(max, row.uid), 0) + 1, uidValidity: 1 }; });
      case 'imap_search_all_uids': return { uids: visible(accountId, mailbox).map(row => row.uid) };
      case 'imap_search_emails': {
        const query = String(args.query || '').trim().toLowerCase();
        const filters = args.filters || {};
        const rows = visible(accountId, mailbox).filter(row => {
          const haystack = [row.subject, row.text, row.from?.name, row.from?.address, ...(row.to || []).map(item => item.address)].join(' ').toLowerCase();
          if (query && !haystack.includes(query)) return false;
          if (filters.from && !row.from?.address?.toLowerCase().includes(String(filters.from).toLowerCase()) && !row.from?.name?.toLowerCase().includes(String(filters.from).toLowerCase())) return false;
          if (filters.since && row.date < filters.since) return false;
          if (filters.before && row.date > filters.before) return false;
          return true;
        }).sort((a, b) => b.uid - a.uid);
        return { emails: rows.map(header), total: rows.length, simulated: true };
      }
      case 'imap_fetch_headers_by_uids': return (args.uids || []).map(uid => find({ accountId, mailbox, uid })).filter(Boolean).map(header);
      case 'imap_get_email': { const row = find({ accountId, mailbox, uid: args.uid }); return { email: row ? clone(row) : null }; }
      case 'imap_get_email_light': { const row = find({ accountId, mailbox, uid: args.uid }); return { email: row ? header(row) : null }; }
      case 'imap_set_flags': {
        const row = find({ accountId, mailbox, uid: args.uid }); if (row) row.flags = args.action === 'remove' ? row.flags.filter(flag => !(args.flags || []).includes(flag)) : [...new Set([...row.flags, ...(args.flags || [])])];
        emit('demo:state', { type: 'flags', id: row?.id }); return { success: true, simulated: true };
      }
      case 'imap_delete_email': {
        const row = find({ accountId, mailbox, uid: args.uid }); let trash = null; let trashUid = null; if (row) {
          if (args.permanent === false) {
            trash = 'Trash';
            trashUid = Math.max(0, ...messages.filter(item => item.accountId === accountId && item.mailbox === 'Trash').map(item => item.uid)) + 1;
            messages.push({ ...row, id: `demo-${accountId}-Trash-${trashUid}`, mailbox: 'Trash', _mailbox: 'Trash', uid: trashUid, localId: `${accountId}-Trash-${trashUid}`, serverPresent: true, serverDeleted: false, serverAbsent: false, vaultPresent: false, _origin: null, source: 'server' });
          }
          row.serverPresent = false; row.serverDeleted = true; row.serverAbsent = true;
        }
        emit('demo:state', { type: 'server-delete', id: row?.id }); return { success: true, trash, trashUid, simulated: true };
      }
      case 'imap_move_emails': {
        const newUids = [];
        for (const uid of args.uids || []) {
          const row = find({ accountId, mailbox: args.sourceMailbox, uid });
          if (!row) continue;
          const existingLocal = messages.find(item => item !== row && item.accountId === accountId && item.messageId === row.messageId && item.mailbox === args.targetMailbox && item.vaultPresent);
          if (existingLocal && !row.vaultPresent) {
            existingLocal.serverPresent = true; existingLocal.serverAbsent = false; existingLocal.serverDeleted = false;
            messages = messages.filter(item => item !== row);
          } else if (row.vaultPresent && row.serverPresent) {
            row.serverPresent = false; row.serverAbsent = true;
            const moved = { ...row, id: `demo-${accountId}-${args.targetMailbox}-${row.uid}`, mailbox: args.targetMailbox, _mailbox: args.targetMailbox, localId: `${accountId}-${args.targetMailbox}-${row.uid}`, vaultPresent: false, _origin: null, source: 'server', serverPresent: true, serverAbsent: false, serverDeleted: false };
            messages.push(moved);
          } else {
            row.mailbox = args.targetMailbox; row._mailbox = args.targetMailbox; row.localId = `${accountId}-${args.targetMailbox}-${row.uid}`; row.id = `demo-${accountId}-${args.targetMailbox}-${row.uid}`;
          }
          newUids.push(row.uid);
        }
        emit('demo:state', { type: 'move' }); return { success: true, simulated: true, newUids };
      }
      case 'imap_create_mailbox': {
        const path = args.path || 'New folder';
        const scoped = accountMailboxAdds.get(accountId) || [];
        if (!mailboxPaths().includes(path) && !scoped.some(item => item.path === path)) { scoped.push({ path, name: path.split('/').pop(), delimiter: '/', flags: ['\\HasNoChildren'] }); accountMailboxAdds.set(accountId, scoped); }
        emit('demo:state', { type: 'mailbox-create', path }); return { success: true, path, simulated: true };
      }
      case 'imap_rename_mailbox': {
        const from = args.from; const to = args.to;
        for (const row of messages) if (row.accountId === accountId && (row.mailbox === from || row.mailbox.startsWith(`${from}/`))) { row.mailbox = `${to}${row.mailbox.slice(from.length)}`; row._mailbox = row.mailbox; row.localId = `${row.accountId}-${row.mailbox}-${row.uid}`; }
        const rename = nodes => (nodes || []).forEach(node => { if (node.path === from || node.path.startsWith(`${from}/`)) { node.path = `${to}${node.path.slice(from.length)}`; node.name = node.path.split('/').pop(); } rename(node.children); });
        rename(mailboxList);
        const custom = accountMailboxAdds.get(accountId) || [];
        custom.forEach(node => { if (node.path === from || node.path.startsWith(`${from}/`)) { node.path = `${to}${node.path.slice(from.length)}`; node.name = node.path.split('/').pop(); } });
        emit('demo:state', { type: 'mailbox-rename', from, to }); return { success: true, simulated: true };
      }
      case 'imap_delete_mailbox': {
        const paths = args.paths || [args.path];
        mailboxList = mailboxList.filter(node => !paths.includes(node.path) && !paths.some(path => node.path.startsWith(`${path}/`)));
        const custom = accountMailboxAdds.get(accountId) || [];
        accountMailboxAdds.set(accountId, custom.filter(node => !paths.includes(node.path) && !paths.some(path => node.path.startsWith(`${path}/`))));
        for (const path of paths) messages = messages.filter(row => !(row.accountId === accountId && (row.mailbox === path || row.mailbox.startsWith(`${path}/`))));
        emit('demo:state', { type: 'mailbox-delete', paths }); return { success: true, simulated: true };
      }
      case 'imap_ensure_sent_mailbox': return 'Sent';
      case 'smtp_build_mime': case 'smtp_build_draft_mime': {
        const email = args.email || {}; const built = buildMime(accountId, email); builtMimes.set(`${accountId}|${email.subject || ''}|${email.to || ''}|${email.cc || ''}`, built); return built;
      }
      case 'smtp_send_email': {
        const email = args.email || {}; const targetAccount = args.account?.id || accountId || ACCOUNT_IDS[0]; const uid = Math.max(0, ...messages.filter(row => row.accountId === targetAccount).map(row => row.uid)) + 1;
        const built = builtMimes.get(`${targetAccount}|${email.subject || ''}|${email.to || ''}|${email.cc || ''}`) || buildMime(targetAccount, email);
        const sent = makeMessage({ accountId: targetAccount, mailbox: args.sentMailbox || 'Sent', uid, from: plain({ name: ACCOUNTS.find(row => row.id === targetAccount)?.name || 'Demo sender', address: ACCOUNTS.find(row => row.id === targetAccount)?.email || 'demo@mailvault.demo' }), to: email.to, cc: email.cc ? (Array.isArray(email.cc) ? email.cc : String(email.cc).split(',').map(address => plain({ name: '', address: address.trim() }))) : [], bcc: email.bcc ? (Array.isArray(email.bcc) ? email.bcc : String(email.bcc).split(',').map(address => plain({ name: '', address: address.trim() }))) : [], subject: email.subject || '(No subject)', text: email.text || '', htmlContent: email.html || null, attachments: email.attachments || [], daysAgo: 0, vault: true, server: true, messageId: built.messageId, inReplyTo: email.inReplyTo || email.in_reply_to || null, references: email.references ? (Array.isArray(email.references) ? email.references : String(email.references).split(/\s+/)) : [] }, Date.now());
        sent.rawSource = sent.rawSource.replace(/Message-ID: .*\r?\n/i, `Message-ID: ${built.messageId}\r\n`); sent.rawSourceBase64 = btoa(unescape(encodeURIComponent(sent.rawSource)));
        messages.push(sent);
        emit('send-server-append-complete', { accountId: targetAccount, ok: true, uid, messageIdHeader: sent.messageId, verify: { existsBefore: uid - 1, existsAfter: uid, delta: 1, foundUid: uid } });
        emit('demo:state', { type: 'send', uid }); return { success: true, simulated: true, uid, messageId: sent.messageId };
      }
      case 'maildir_store': {
        let row = find({ accountId, mailbox, uid: args.uid });
        let parsed = null;
        if (args.rawSourceBase64) {
          try { parsed = parseMime(decodeURIComponent(escape(atob(args.rawSourceBase64)))); } catch { parsed = null; }
        }
        if (!row) {
          row = makeMessage({ accountId, mailbox, uid: args.uid, from: parsed?.from || plain({ name: 'Demo sender', address: 'demo@mailvault.demo' }), to: parsed?.to || null, cc: parsed?.cc || [], bcc: parsed?.bcc || [], subject: parsed?.subject || '(No subject)', text: parsed?.text || '', htmlContent: parsed?.html, attachments: parsed?.attachments || [], vault: true, server: false, messageId: parsed?.messageId || null }, Date.now());
          messages.push(row);
        }
        if (parsed) {
          row.from = parsed.from; row.to = parsed.to; row.cc = parsed.cc; row.bcc = parsed.bcc; row.subject = parsed.subject; row.text = parsed.text; row.html = parsed.html || row.html; row.attachments = parsed.attachments || row.attachments; row.hasAttachments = row.attachments.length > 0;
          row.date = parsed.date || row.date; row.internalDate = row.date; if (parsed.messageId) row.messageId = parsed.messageId;
          row.rawSourceBase64 = args.rawSourceBase64; try { row.rawSource = decodeURIComponent(escape(atob(args.rawSourceBase64))); } catch { /* keep prior bytes */ }
        }
        row.vaultPresent = true; row._origin = row._origin || 'local'; row.source = row.source || 'local'; row.serverAbsent = !row.serverPresent;
        if (args.flags) row.vaultFlags = [...args.flags];
        emit('demo:state', { type: (args.flags || []).includes('draft') || mailbox === 'Drafts' ? 'draft-saved' : 'archive', id: row.id }); return { success: true, simulated: true };
      }
      case 'maildir_exists': return !!find({ accountId, mailbox, uid: args.uid })?.vaultPresent;
      case 'maildir_list': {
        const requireFlag = args.requireFlag;
        return local(accountId, mailbox)
          .filter(row => !requireFlag || (row.vaultFlags || []).includes(requireFlag))
          .map(row => ({ uid: row.uid, flags: [...(row.vaultFlags || [])], isArchived: (row.vaultFlags || []).includes('archived') }));
      }
      case 'maildir_read': case 'maildir_read_light': { const row = find({ accountId, mailbox, uid: args.uid }); return row && row.vaultPresent ? clone(row) : null; }
      case 'maildir_read_light_batch': return (args.uids || []).map(uid => { const row = find({ accountId, mailbox, uid }); return row && row.vaultPresent ? header(row) : null; });
      case 'maildir_read_raw_source': { const row = find({ accountId, mailbox, uid: args.uid }); return row?.rawSourceBase64 || null; }
      case 'maildir_read_attachment': { const row = find({ accountId, mailbox, uid: args.uid }); return row?.attachments?.[args.attachmentIndex]?.content || null; }
      case 'cache_attachment': {
        const row = find({ accountId, mailbox, uid: args.uid });
        const attachment = row?.attachments?.[args.attachmentIndex];
        if (!attachment?.content) return null;
        const filename = attachment.filename || attachment.name || 'mailvault-demo-attachment';
        if (typeof document !== 'undefined') {
          const bytes = Uint8Array.from(atob(String(attachment.content).replace(/^data:[^;]+;base64,/, '')), char => char.charCodeAt(0));
          downloadBrowserFile(filename, bytes, attachment.contentType || 'application/octet-stream');
        }
        return `browser-downloads/${filename}`;
      }
      case 'cached_attachment_path': return null;
      case 'save_attachment_to': {
        if (typeof document !== 'undefined' && args.contentBase64) {
          try {
            const filename = String(args.destPath || 'mailvault-demo-download').split('/').pop();
            downloadBrowserFile(filename, Uint8Array.from(atob(args.contentBase64), char => char.charCodeAt(0)), args.contentType || 'application/octet-stream');
          } catch { /* browser download is best effort; report the simulated path below */ }
        }
        return args.destPath || null;
      }
      case 'maildir_set_flags': { const row = find({ accountId, mailbox, uid: args.uid }); if (row) row.vaultFlags = args.flags || row.vaultFlags || []; return null; }
      case 'maildir_delete': { const row = find({ accountId, mailbox, uid: args.uid }); if (row) row.vaultPresent = false; const draftCleanup = mailbox === 'Drafts' || row?.flags?.includes('draft') || row?.vaultFlags?.includes('draft'); emit('demo:state', { type: draftCleanup ? 'draft-deleted' : 'vault-delete', id: row?.id }); return { success: true, simulated: true }; }
      case 'maildir_delete_many': { const rows = (args.uids || []).map(uid => find({ accountId, mailbox, uid })).filter(Boolean); rows.forEach(row => { row.vaultPresent = false; }); emit('demo:state', { type: 'vault-delete-many' }); return { removed: rows.length, simulated: true }; }
      case 'maildir_read_archived_cached': case 'maildir_read_archived': { const row = find({ accountId, mailbox, uid: args.uid }); return row?.vaultPresent ? clone(row) : null; }
      case 'maildir_save_archived_cache': case 'maildir_clear_cache': return { success: true, simulated: true };
      case 'local_index_remove': return { removed: 1, simulated: true };
      case 'verify_archived_emails': {
        const uids = args.uids || []; const expected = args.expectedIds || {};
        const verified = uids.filter(uid => { const row = find({ accountId, mailbox, uid }); return !!row?.vaultPresent && (!expected[uid] || expected[uid] === row.messageId); });
        return { verified, missing: uids.filter(uid => !verified.includes(uid)), mismatched: [], simulated: true };
      }
      case 'bulk_delete_emails': {
        const uids = args.uids || []; const rows = uids.map(uid => find({ accountId, mailbox, uid })).filter(Boolean); rows.forEach(row => { row.serverPresent = false; row.serverAbsent = true; row.serverDeleted = true; });
        emit('bulk-operation-progress', { completed: rows.length, errors: [], phase: 'delete', total: uids.length }); emit('demo:state', { type: 'bulk-delete' });
        return { success: true, deleted: rows.length, completed: rows.length, simulated: true };
      }
      case 'local_index_read': return JSON.stringify(local(accountId, mailbox).map(row => ({ ...header(row), uid: row.uid, source: row._origin || 'local', serverDeleted: row.serverDeleted, serverAbsent: row.serverAbsent })));
      case 'load_email_cache_meta': { const rows = visible(accountId, mailbox); return { totalEmails: rows.length, totalCached: rows.length, uidValidity: 1, uidNext: rows.reduce((max, row) => Math.max(max, row.uid), 0) + 1, highestModseq: rows.length + 1 }; }
      case 'load_email_cache_partial': { const rows = visible(accountId, mailbox).sort((a, b) => b.uid - a.uid); return JSON.stringify({ emails: rows.slice(0, args.limit || 500).map(header), totalEmails: rows.length }); }
      case 'load_email_cache': return JSON.stringify(visible(accountId, mailbox).map(header));
      case 'load_email_cache_by_uids': return (args.uids || []).map(uid => { const row = find({ accountId, mailbox, uid }); return row ? header(row) : null; }).filter(Boolean);
      case 'save_email_cache': case 'save_mailbox_cache': case 'save_graph_id_map': case 'clear_email_cache': case 'delete_mailbox_cache': return null;
      case 'load_mailbox_cache': return JSON.stringify({ mailboxes: accountMailboxes(accountId), fetchedAt: sessionNow, lastKnownGoodMailboxes: accountMailboxes(accountId), lastKnownGoodAt: sessionNow });
      case 'list_cached_uids': return { uids: local(accountId, mailbox).map(row => row.uid), changed: [] };
      case 'local_index_append': {
        const entries = typeof args.entriesJson === 'string' ? JSON.parse(args.entriesJson) : (args.entries || []);
        for (const entry of entries) {
          let row = find({ accountId, mailbox, uid: entry.uid });
          if (!row) {
            // An index write records metadata; it does not create a Maildir
            // file. Body creation belongs to maildir_store, so a stale index
            // update can never resurrect a deleted local message.
            row = makeMessage({ accountId, mailbox, uid: entry.uid, from: entry.from || plain({ name: 'Demo sender', address: 'demo@mailvault.demo' }), to: entry.to || null, subject: entry.subject || '(No subject)', text: entry.snippet || '', vault: false, server: false }, Date.now());
            messages.push(row);
          }
          const writable = ['uid', 'from', 'to', 'cc', 'bcc', 'subject', 'date', 'messageDate', 'receivedAt', 'sentAt', 'flags', 'has_attachments', 'message_id', 'in_reply_to', 'references', 'snippet', 'serverDeleted', 'serverAbsent'];
          for (const field of writable) if (Object.hasOwn(entry, field)) row[field] = entry[field];
          if (Object.hasOwn(entry, 'message_id')) row.messageId = entry.message_id;
          if (Object.hasOwn(entry, 'in_reply_to')) row.inReplyTo = entry.in_reply_to;
          if (Object.hasOwn(entry, 'has_attachments')) row.hasAttachments = entry.has_attachments;
          Object.assign(row, { _origin: entry.source || row._origin, source: entry.source || row.source || 'local', serverAbsent: !row.serverPresent });
        }
        return { appended: entries.length, simulated: true };
      }
      case 'maildir_storage_stats': return { totalMB: 0.16, totalBytes: 167000, emailCount: messages.filter(row => row.vaultPresent).length, mailboxCount: new Set(messages.filter(row => row.vaultPresent).map(row => `${row.accountId}|${row.mailbox}`)).size };
      case 'check_network_connectivity': return true;
      case 'spellcheck_status': return { available: false, language: null };
      case 'get_client_info': return { version: '2.13.1-demo', platform: 'browser', simulated: true };
      case 'set_badge_count': case 'apply_menu_labels': case 'set_update_track': return { success: true, simulated: true };
      case 'archive_emails': {
        const rows = (args.uids || []).map(uid => find({ accountId, mailbox, uid })).filter(Boolean);
        rows.forEach(row => { row.vaultPresent = true; row.vaultFlags = [...new Set([...(row.vaultFlags || []), 'archived'])]; row._origin = 'local'; });
        emit('archive-progress', { completed: rows.length, errors: [], total: rows.length });
        return { success: true, simulated: true, completed: rows.length, total: rows.length };
      }
      case 'cancel_archive': return { success: true, simulated: true };
      case 'insights_begin_snapshot': {
        const rows = messages.filter(row => (args.accountIds || ACCOUNT_IDS).includes(row.accountId)); const id = `demo-snapshot-${++snapshotSeq}`; snapshots.set(id, rows); return { snapshotId: id, inventoryCount: rows.length, coverage: { status: 'ready', updatedAt: new Date().toISOString(), folders: [], warnings: { unknownDates: 0, fallbackDates: 0, uncertainIdentity: 0, unreadableFiles: 0 }, errors: [] } };
      }
      case 'insights_read_page': { const rows = snapshots.get(args.snapshotId) || []; return { rows: rows.map(row => ({ ...header(row), source: row.vaultPresent ? 'vault' : 'server-cache', origin: row._origin, receivedAt: row.date, sentAt: row.mailbox === 'Sent' ? row.date : null, messageDate: row.date, dateEvidence: { received: 'header', sent: row.mailbox === 'Sent' ? 'header' : 'none' }, serverDeleted: !row.serverPresent, serverAbsent: !row.serverPresent, localMailbox: row.mailbox })), nextCursor: null, coverage: { status: 'ready', updatedAt: new Date().toISOString(), folders: [], warnings: { unknownDates: 0, fallbackDates: 0, uncertainIdentity: 0, unreadableFiles: 0 }, errors: [] } }; }
      case 'insights_release_snapshot': snapshots.delete(args.snapshotId); return null;
      case 'ping': return { pong: true, simulated: true };
      case 'net.probe': case 'check_network_connectivity': return true;
      case 'contacts_index.get': return Object.fromEntries(ACCOUNT_IDS.map(id => [id, []]));
      case 'load_graph_id_map': case 'graph_cache_mime': return {};
      case 'graph_list_folders': return { folders: clone(accountMailboxes(accountId)), simulated: true };
      case 'graph_list_messages': return { messages: visible(accountId, mailbox).map(header), total: visible(accountId, mailbox).length, simulated: true };
      case 'graph_get_message': { const row = find({ accountId, mailbox, uid: args.uid }); return row ? { message: clone(row), simulated: true } : null; }
      case 'graph_create_folder': return invoke('imap_create_mailbox', { ...args, path: args.path || args.name });
      case 'graph_delete_folder': return invoke('imap_delete_mailbox', args);
      case 'graph_move_folder': case 'graph_rename_folder': return invoke('imap_rename_mailbox', { ...args, from: args.from || args.source, to: args.to || args.target });
      case 'graph_move_emails': return invoke('imap_move_emails', { ...args, sourceMailbox: args.sourceMailbox || mailbox, targetMailbox: args.targetMailbox || args.destination });
      case 'graph_set_read': case 'graph_set_flagged': return { success: true, simulated: true };
      case 'graph_delete_message': return invoke('imap_delete_email', { ...args, mailbox, permanent: args.permanent ?? false });
      case 'imap_disconnect': return { success: true, simulated: true };
      case 'imap_find_message_id': {
        const found = messages.filter(row => (!accountId || row.accountId === accountId) && row.messageId === args.messageId).map(row => ({ mailbox: row.mailbox, uid: row.uid }));
        return { messageId: args.messageId, found, searched: mailboxPaths(), failed: [], complete: true, simulated: true };
      }
      case 'prefetch_attachments': return { success: true, cached: 0, simulated: true };
      case 'read_dropped_files': return [];
      case 'resolve_email_settings': return { domain: args.domain || null, simulated: true };
      case 'get_folder_mappings': {
        const source = typeof args.sourceAccount === 'string' ? JSON.parse(args.sourceAccount) : (args.sourceAccount || {});
        const sourceId = source.id || source.accountId || ACCOUNT_IDS[0];
        return accountMailboxes(sourceId).map(folder => ({ source_path: folder.path, dest_path: folder.path, email_count: messages.filter(row => row.accountId === sourceId && row.mailbox === folder.path && row.serverPresent).length }));
      }
      case 'backup_purge_uids': return { removed: 0, queued: 0, simulated: true };
      case 'start_migration': {
        const source = typeof args.sourceAccount === 'string' ? JSON.parse(args.sourceAccount) : (args.sourceAccount || {});
        const destination = typeof args.destAccount === 'string' ? JSON.parse(args.destAccount) : (args.destAccount || {});
        const sourceId = source.id || source.accountId || ACCOUNT_IDS[0];
        const destinationId = destination.id || destination.accountId || ACCOUNT_IDS[1];
        const mappings = Array.isArray(args.folderMappings) && args.folderMappings.length ? args.folderMappings : [{ source_path: 'INBOX', dest_path: 'INBOX' }];
        let nextUid = Math.max(0, ...messages.filter(row => row.accountId === destinationId).map(row => Number(row.uid) || 0)) + 1;
        const folders = [];
        let totalEmails = 0; let migratedEmails = 0; let skippedEmails = 0;
        for (const mapping of mappings) {
          const sourcePath = mapping.source_path || mapping.source || 'INBOX';
          const destPath = mapping.dest_path || mapping.destination || sourcePath;
          const sourceRows = messages.filter(row => row.accountId === sourceId && row.mailbox === sourcePath && (args.includeLocalArchive ? (row.serverPresent || row.vaultPresent) : row.serverPresent));
          let migrated = 0; let skipped = 0;
          if (!accountMailboxes(destinationId).some(folder => folder.path === destPath)) {
            if (!accountMailboxAdds.has(destinationId)) accountMailboxAdds.set(destinationId, []);
            accountMailboxAdds.get(destinationId).push({ path: destPath, name: destPath.split('/').pop(), delimiter: '/', flags: [] });
          }
          for (const sourceRow of sourceRows) {
            totalEmails += 1;
            const duplicate = messages.find(row => row.accountId === destinationId && row.mailbox === destPath && row.messageId === sourceRow.messageId);
            if (duplicate) { skipped += 1; skippedEmails += 1; continue; }
            const copied = makeMessage({ accountId: destinationId, mailbox: destPath, uid: nextUid++, from: clone(sourceRow.from), to: clone(sourceRow.to), cc: clone(sourceRow.cc), bcc: clone(sourceRow.bcc), subject: sourceRow.subject, text: sourceRow.text, htmlContent: sourceRow.html, vault: true, server: true, attachments: clone(sourceRow.attachments || []), threadId: sourceRow.threadId, inReplyTo: sourceRow.inReplyTo, references: clone(sourceRow.references || []), messageId: sourceRow.messageId }, sessionNow);
            Object.assign(copied, { date: sourceRow.date, internalDate: sourceRow.internalDate || sourceRow.date, flags: [...(sourceRow.flags || [])], vaultFlags: [...new Set(['archived', ...(sourceRow.vaultFlags || []).filter(flag => flag !== 'archived')])], rawSource: sourceRow.rawSource, rawSourceBase64: sourceRow.rawSourceBase64 });
            messages.push(copied);
            migrated += 1; migratedEmails += 1;
          }
          folders.push({ source_path: sourcePath, dest_path: destPath, total: sourceRows.length, done: sourceRows.length, migrated, skipped, failed: 0, status: 'completed' });
        }
        migrationState = { status: 'completed', progress: 1, source_email: source.email || ACCOUNTS.find(row => row.id === sourceId)?.email, dest_email: destination.email || ACCOUNTS.find(row => row.id === destinationId)?.email, total_folders: mappings.length, migrated_folders: mappings.length, total_emails: totalEmails, migrated_emails: migratedEmails, skipped_emails: skippedEmails, failed_emails: 0, elapsed_seconds: 1, folders, simulated: true };
        emit('migration-progress', migrationState); emit('demo:state', { type: 'migration' });
        return migrationState;
      }
      case 'cancel_migration': migrationState = { ...(migrationState || {}), status: 'cancelled', simulated: true }; emit('migration-progress', migrationState); return migrationState;
      case 'pause_migration': migrationState = { ...(migrationState || {}), status: 'paused', simulated: true }; emit('migration-progress', migrationState); return migrationState;
      case 'resume_migration': migrationState = { ...(migrationState || {}), status: 'completed', progress: 1, simulated: true }; emit('migration-progress', migrationState); return migrationState;
      case 'count_migration_folders': {
        const source = typeof args.sourceAccount === 'string' ? JSON.parse(args.sourceAccount) : (args.sourceAccount || {});
        const sourceId = source.id || source.accountId || ACCOUNT_IDS[0];
        const mappings = Array.isArray(args.folderMappings) ? args.folderMappings : [];
        const sourceRows = messages.filter(row => row.accountId === sourceId && row.serverPresent);
        const folders = mappings.map(mapping => ({ path: mapping.source_path, count: sourceRows.filter(row => row.mailbox === mapping.source_path).length }));
        folders.forEach(folder => emit('migration-folder-count', { folder_path: folder.path, count: folder.count, counting: false }));
        return { total: mappings.length, folders, simulated: true };
      }
      case 'start_restore': {
        const account = typeof args.account === 'string' ? JSON.parse(args.account) : (args.account || {});
        const restoreAccountId = args.accountId || account.id || account.accountId || ACCOUNT_IDS[0];
        const folders = new Set(Array.isArray(args.folders) ? args.folders : []);
        const candidates = messages.filter(row => row.accountId === restoreAccountId && row.vaultPresent && !row.serverPresent && (!folders.size || folders.has(row.mailbox)));
        candidates.forEach(row => { row.serverPresent = true; row.serverAbsent = false; row.serverDeleted = false; });
        const progress = { account_id: restoreAccountId, email: account.email || ACCOUNTS.find(row => row.id === restoreAccountId)?.email, total_emails: candidates.length, uploaded_emails: candidates.length, skipped_emails: 0, failed_emails: 0, current_folder: null, folder_progress: `${candidates.length}/${candidates.length}`, status: 'running', simulated: true };
        emit('restore-progress', progress);
        const done = { ...progress, status: 'completed' };
        setTimeout(() => emit('restore-progress', done), 60);
        emit('demo:state', { type: 'restore' });
        return { ...done, restored: candidates.length };
      }
      case 'cancel_restore': return { status: 'cancelled', simulated: true };
      case 'vault_inspect_folder': return { kind: 'empty', path: args.path, simulated: true };
      case 'vault_adopt': case 'vault_move_to': case 'vault_move_to_default': return { status: 'ready', displayPath: 'Browser demo vault', platform: 'browser', simulated: true };
      case 'vault_rename_mailbox': return { success: true, simulated: true };
      case 'vault_reset': messages.forEach(row => { row.vaultPresent = false; }); emit('demo:state', { type: 'vault-reset' }); return { success: true, simulated: true };
      case 'export_backup': {
        const rows = messages.filter(row => row.vaultPresent && (!args.archivedOnly || row.vaultPresent));
        const payload = JSON.stringify({ format: 'mailvault-browser-demo', accounts: ACCOUNTS.map(row => ({ id: row.id, email: row.email })), messages: rows.map(row => ({ ...header(row), rawSourceBase64: row.rawSourceBase64 })) }, null, 2);
        downloadBrowserFile('mailvault-demo-backup.json', payload, 'application/json');
        emit('export-progress', { total: rows.length, completed: rows.length, active: false }); emit('demo:state', { type: 'export' });
        return { success: true, emailCount: rows.length, accountCount: new Set(rows.map(row => row.accountId)).size, simulated: true, format: 'json' };
      }
      case 'import_backup': {
        const target = ACCOUNT_IDS[0];
        const uid = Math.max(0, ...messages.filter(row => row.accountId === target).map(row => row.uid)) + 1;
        messages.push(makeMessage({ accountId: target, mailbox: 'Archive', uid, from: plain({ name: 'MailVault demo', address: 'demo@mailvault.demo' }), subject: 'Imported sample archive', text: 'This fictional message was restored from the browser demo backup.', vault: true, server: false }, sessionNow));
        emit('import-progress', { total: 1, completed: 1, active: false }); emit('demo:state', { type: 'import' });
        return { success: true, emailCount: 1, accountCount: 1, newAccounts: [], simulated: true };
      }
      case 'export_mbox_all': {
        const rows = messages.filter(row => row.vaultPresent);
        const mbox = rows.map(row => `From ${row.from?.address || 'demo@mailvault.demo'} ${row.date}\n${row.rawSource || ''}\n`).join('\n');
        downloadBrowserFile('mailvault-demo-export.mbox', mbox, 'application/mbox');
        emit('mbox-export-progress', { total: rows.length, completed: rows.length, active: false }); emit('demo:state', { type: 'export' });
        return { success: true, emailCount: rows.length, accountCount: new Set(rows.map(row => row.accountId)).size, simulated: true };
      }
      case 'import_mbox': {
        const target = args.accountId || ACCOUNT_IDS[0];
        const targetMailbox = args.mailbox || 'INBOX';
        const uid = Math.max(0, ...messages.filter(row => row.accountId === target).map(row => row.uid)) + 1;
        messages.push(makeMessage({ accountId: target, mailbox: targetMailbox, uid, from: plain({ name: 'MBOX sample', address: 'imported@mailvault.demo' }), subject: 'Imported sample MBOX message', text: 'This fictional message demonstrates an MBOX import in the browser.', vault: true, server: false }, sessionNow));
        emit('mbox-import-progress', { total: 1, completed: 1, active: false }); emit('demo:state', { type: 'import' });
        return { success: true, emailCount: 1, simulated: true };
      }
      case 'install_pending_update': return unsupported(command);
      case 'fetch_remote_asset': return unsupported(command);
      case 'open_file': case 'open_email_window': return unsupported(command);
      case 'oauth2_auth_url': case 'oauth2_exchange': case 'oauth2_refresh': case 'imap_test_connection': case 'smtp_test_connection': case 'store_password': case 'store_credentials': return unsupported(command);
      default: return unsupported(command);
    }
    return null;
  };

  return {
    accounts: clone(ACCOUNTS),
    snapshot: () => ({ accounts: clone(ACCOUNTS), mailboxes: clone(MAILBOXES), messages: clone(messages).map(row => ({ ...row, custody: row.serverPresent && row.vaultPresent ? 'both' : row.serverPresent ? 'server' : 'local-only' })) }),
    exportState,
    restoreState,
    invoke,
    on: (event, callback) => { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event).add(callback); return () => listeners.get(event)?.delete(callback); },
    reset: () => { messages = seedMessages(sessionNow); mailboxList = clone(MAILBOXES); accountMailboxAdds.clear(); settings = clone(initialSettings); journal.length = 0; pendingOperation = null; migrationState = null; snapshots.clear(); timeCapsules.clear(); capsuleInitialized.clear(); builtMimes.clear(); learning.clear(); classificationOverrides.clear(); externalBackupPath = null; syncTickets.clear(); syncTicket = 0; emit('demo:state', { type: 'reset' }); },
    DemoUnsupportedError,
  };
}

export { ACCOUNTS, ACCOUNT_IDS, MAILBOXES, DemoUnsupportedError };
