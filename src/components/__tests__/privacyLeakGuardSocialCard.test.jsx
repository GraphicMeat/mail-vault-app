// @vitest-environment jsdom
/**
 * The social card's header boxes (sender details and links), checked by their
 * OUTCOME like privacyLeakGuard.test.jsx: with redaction on and the sender
 * reveal off, no fixture person may appear anywhere in the HTML the rasterizer
 * is handed, however the mail words its headers and links. With the reveal on,
 * only the sender's own exact values may.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../services/export/renderMessageToCanvas', () => ({ renderMessageToCanvas: vi.fn(), measureMessageHeight: vi.fn() }));
vi.mock('../../stores/settingsStore', () => ({
  hasPremiumAccess: () => true,
  useSettingsStore: { getState: () => ({ billingProfile: { hasSubscription: true } }) },
}));
vi.mock('../../stores/mailStore', () => ({
  useMailStore: { getState: () => ({ accounts: [], activeAccountId: 'acct-1', activeMailbox: 'INBOX' }) },
}));

const { prepareSocialMessage } = await import('../../services/export/exportService');
const { buildMessageDocument } = await import('../../services/export/exportDocument');
const { senderDetailsHtml } = await import('../../services/export/social/senderDetails');
const { socialLinksHtml } = await import('../../services/export/social/socialLinks');
const { buildNameDictionary } = await import('../../utils/privacy/piiDetector');
const { PEOPLE, FIXTURE_MESSAGE, NEEDLES } = await import('../../test/privacyFixtures');

const [JOANNA, ROKAS, OWEN] = PEOPLE.names;
const [JOANNA_MAIL, ROKAS_MAIL, OWEN_MAIL] = PEOPLE.emails;
const dict = buildNameDictionary({ names: PEOPLE.names });

// Every field the boxes read, worded with the people the guard knows about.
const HTML = [
  `<p>Hi ${ROKAS}</p>`,
  `<a href="https://track.example/u/${encodeURIComponent(JOANNA_MAIL)}?n=${encodeURIComponent(OWEN)}">Unsubscribe ${JOANNA}</a>`,
  `<a href="http://rokas.shop.example/me">https://${ROKAS.split(' ')[0].toLowerCase()}.example.lt/profile</a>`,
  `<a href="javascript:go('${ROKAS_MAIL}')">${PEOPLE.phones[0]}</a>`,
  `<a href="https://owen.example/p">${OWEN_MAIL}</a>`,
].join('');
const impersonation = {
  ...FIXTURE_MESSAGE,
  // A display name that is another person's address, a Reply-To to a third, and failed checks.
  from: { name: OWEN_MAIL, address: JOANNA_MAIL },
  replyTo: [{ name: ROKAS, address: ROKAS_MAIL }],
  authenticationResults: 'mx; spf=fail; dkim=fail; dmarc=fail',
  html: HTML,
};
const plain = { ...FIXTURE_MESSAGE, replyTo: [{ address: OWEN_MAIL }], html: HTML };

async function cardHeadHtml(message, redact) {
  const prepared = await prepareSocialMessage(message, { mirror: false, redact, details: true, links: true });
  const extrasHtml = senderDetailsHtml(prepared.details) + socialLinksHtml(prepared.links);
  return { prepared, extrasHtml, html: buildMessageDocument({ message: prepared.message, part: 'head', extrasHtml }) };
}
const noLeak = (s, needles = NEEDLES) => needles.forEach(n => expect(s, n).not.toContain(n));

describe('privacy leak guard: social card header boxes', () => {
  it('redacted, reveal off: no fixture person in the sender-details box, the links list or the header', async () => {
    for (const message of [impersonation, plain]) {
      const { html, extrasHtml } = await cardHeadHtml(message, { dict, format: 'image' });
      // The boxes reached the document, masked, so an empty render cannot pass for a clean one.
      expect(extrasHtml).toContain('Sender Details');
      expect(extrasHtml).toContain('data-mv-box="links"');
      expect(extrasHtml).toMatch(/x{3,}/);
      noLeak(html);
    }
  });

  it('redacted, reveal on: only the sender\'s exact values show, everyone else stays masked', async () => {
    const reveal = new Set([JOANNA_MAIL, OWEN_MAIL.toLowerCase()]);
    const { html, extrasHtml } = await cardHeadHtml(impersonation, { dict: { ...dict, reveal }, format: 'image' });
    expect(extrasHtml).toContain(JOANNA_MAIL);
    noLeak(html, NEEDLES.filter(n => !reveal.has(n) && !JOANNA_MAIL.includes(n) && !OWEN_MAIL.includes(n)));
    // Rokas (the recipient, not in the set) never shows, in the Reply-To or the links.
    for (const n of [ROKAS, ROKAS_MAIL, 'Ambrazevičius']) expect(html).not.toContain(n);
  });

  it('unredacted, the same message does show its people (the guard can fail)', async () => {
    const { html } = await cardHeadHtml(impersonation, null);
    expect(html).toContain(JOANNA_MAIL);
    expect(html).toContain(OWEN_MAIL);
  });
});
