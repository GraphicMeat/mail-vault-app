// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../renderMessageToCanvas', () => ({
  // Capture the document the rasterizer would draw, footer and redaction style included.
  renderMessageToCanvas: vi.fn(async ({ message, bodyHtml, account, mailbox, stats, redactStyle }) => {
    const { buildMessageDocument } = await import('../exportDocument');
    globalThis.__lastDoc = buildMessageDocument({ message, bodyHtml, account, mailbox, stats, redactStyle });
    return { width: 10, height: 10, toDataURL: () => 'data:image/png;base64,AAAA' };
  }),
  measureMessageHeight: vi.fn(async () => 100),
}));
vi.mock('../imagePacker', async (orig) => ({
  ...(await orig()),
  stitchPages: (canvases, plan) => plan.map(() => ({ toDataURL: () => 'data:image/png;base64,PAGE' })),
}));
vi.mock('../../../stores/settingsStore', () => ({
  hasPremiumAccess: () => true,
  useSettingsStore: { getState: () => ({ billingProfile: { hasSubscription: true } }) },
}));
vi.mock('../../../stores/mailStore', () => ({
  useMailStore: { getState: () => ({ accounts: [], activeAccountId: 'acct-1', activeMailbox: 'INBOX' }) },
}));

const { buildExport, SAMPLE } = await import('../exportService');
const { buildNameDictionary } = await import('../../../utils/privacy/piiDetector');
const { PEOPLE, FIXTURE_MESSAGE, NEEDLES } = await import('../../../test/privacyFixtures');

const dict = buildNameDictionary({ names: PEOPLE.names });
const msg = { ...FIXTURE_MESSAGE, html: '<p>Hi Rokas Ambrazevičius, mail joanna.k@example.org</p>' };
const decode = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64), c => c.charCodeAt(0)));
const noLeak = (s) => NEEDLES.forEach(n => expect(s, n).not.toContain(n));

beforeEach(() => { globalThis.__lastDoc = ''; });

describe('buildExport with redact', () => {
  it('html export: file name and contents carry no fixture person', async () => {
    const r = await buildExport({ messages: [msg], format: 'html', mirror: false, gate: SAMPLE, account: 'owen@own.example', mailbox: 'INBOX', redact: { style: 'blur', dict } });
    expect(r.ok).toBe(true);
    const doc = decode(r.files[0].base64);
    noLeak(r.files[0].name + doc);
    expect(doc).toContain('█');
  });

  it('image export: the document handed to the rasterizer carries no fixture person', async () => {
    const r = await buildExport({ messages: [msg], format: 'image', mirror: false, gate: SAMPLE, account: 'owen@own.example', mailbox: 'INBOX', redact: { style: 'bar', dict } });
    expect(r.ok).toBe(true);
    noLeak(r.files[0].name + globalThis.__lastDoc);
    // The body's masks are spans the bar style paints over.
    expect(globalThis.__lastDoc).toContain('class="mv-pii"');
    expect(globalThis.__lastDoc).toContain('.mv-pii{background:#16181d');
    expect(globalThis.__lastDoc).toContain('xxxx@xxx.xxxxxxx'); // the masked account in the footer
  });

  it('masks a person the caller dictionary does not know, from the message itself', async () => {
    const r = await buildExport({ messages: [msg], format: 'html', mirror: false, gate: SAMPLE, redact: { style: 'bar', dict: buildNameDictionary({ names: [] }) } });
    noLeak(r.files[0].name + decode(r.files[0].base64));
  });

  it('renames the attachments it embeds', async () => {
    const withAtt = { ...msg, attachments: [{ ...FIXTURE_MESSAGE.attachments[0], content: 'QUJD' }] };
    const r = await buildExport({ messages: [withAtt], format: 'html', mirror: false, gate: SAMPLE, attachments: true, redact: { style: 'bar', dict } });
    const doc = decode(r.files[0].base64);
    noLeak(doc);
    expect(doc).toContain('attachment-1.pdf');
  });

  it('leaves an export without redact as it was', async () => {
    const r = await buildExport({ messages: [msg], format: 'html', mirror: false, gate: SAMPLE });
    expect(decode(r.files[0].base64)).toContain('Joanna Kowalczyk');
  });
});
