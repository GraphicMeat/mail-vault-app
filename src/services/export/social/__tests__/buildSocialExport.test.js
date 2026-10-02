// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

// jsdom has no Worker, so the encode falls back to toBlob here. Three zero bytes read as 'AAAA'.
const stubCanvas = () => ({
  width: 100, height: 100,
  toBlob: (cb) => cb(new Blob([new Uint8Array([0, 0, 0])], { type: 'image/png' })),
});
const renderSocialCard = vi.fn(async () => stubCanvas());
const captureAppWindow = vi.fn(async () => stubCanvas());
const composeSocialImage = vi.fn(() => stubCanvas());

vi.mock('../renderSocialCard', () => ({ renderSocialCard: (...a) => renderSocialCard(...a) }));
vi.mock('../../renderMessageToCanvas', () => ({
  renderMessageToCanvas: vi.fn(async () => stubCanvas()),
  measureMessageHeight: vi.fn(async () => 100),
}));
vi.mock('../captureAppWindow', () => ({ captureAppWindow: (...a) => captureAppWindow(...a) }));
vi.mock('../composeSocialImage', () => ({ composeSocialImage: (...a) => composeSocialImage(...a) }));
const MARK = { icon: { naturalWidth: 256, naturalHeight: 256 }, mark: { naturalWidth: 478, naturalHeight: 84 } };
const loadWatermark = vi.fn(async () => MARK);
vi.mock('../socialWatermark', () => ({ loadWatermark: (...a) => loadWatermark(...a) }));
vi.mock('../../../../stores/settingsStore', () => ({
  hasPremiumAccess: () => true,
  useSettingsStore: { getState: () => ({ billingProfile: { hasSubscription: true } }) },
}));
const mail = vi.hoisted(() => ({ accounts: [] }));
vi.mock('../../../../stores/mailStore', () => ({
  useMailStore: { getState: () => ({ accounts: mail.accounts, activeAccountId: 'acct-1', activeMailbox: 'INBOX' }) },
}));
// A cold host: the dictionary knows nobody, so the message's own parties must cover it.
vi.mock('../../../../utils/privacy/privacyDictionary', async (orig) => {
  const { EMPTY_DICTIONARY } = await import('../../../../utils/privacy/piiDetector');
  return { ...(await orig()), ensurePrivacyDictionary: vi.fn(async () => EMPTY_DICTIONARY) };
});

const { buildSocialExport } = await import('../buildSocialExport');
const { SIZE_PRESETS } = await import('../socialLayout');
const { FIXTURE_MESSAGE, NEEDLES } = await import('../../../../test/privacyFixtures');
const { usePrivacyStore } = await import('../../../../stores/privacyStore');
const { useThemeStore } = await import('../../../../stores/themeStore');

const message = { ...FIXTURE_MESSAGE, html: '<p>Hi Rokas Ambrazevičius, mail joanna.k@example.org or call +370 612 34567</p>' };
const options = {
  content: 'card', size: 'portrait', background: { type: 'gradient', id: 'sunset' },
  padding: 64, radius: 16, shadow: true, chrome: true, redact: true,
};
const noLeak = (s) => NEEDLES.forEach(n => expect(s, n).not.toContain(n));

beforeEach(() => {
  mail.accounts = [];
  renderSocialCard.mockClear(); captureAppWindow.mockClear(); composeSocialImage.mockClear();
  usePrivacyStore.setState({ enabled: false });
  useThemeStore.setState({ theme: 'dark' });
});

describe('buildSocialExport', () => {
  it('card: renders a redacted message and body, fits it whole, and names the file without anyone in it', async () => {
    const r = await buildSocialExport({ message, options });
    expect(r.ok).toBe(true);
    const args = renderSocialCard.mock.calls[0][0];
    noLeak(JSON.stringify(args.message) + args.bodyHtml);
    expect(args.redactStyle).toBe('blur');
    expect(typeof args.onCloneNode).toBe('function');
    expect(composeSocialImage.mock.calls[0][0]).toMatchObject({ size: SIZE_PRESETS.portrait, theme: 'dark' });
    expect(composeSocialImage.mock.calls[0][0]).not.toHaveProperty('fit');
    expect(composeSocialImage.mock.calls[0][0].maxSize).toBeUndefined(); // Save is full size
    noLeak(r.file.name);
    expect(r.file.name.endsWith(' - social.png')).toBe(true);
    expect(r.file.base64).toBe('AAAA');
    expect(usePrivacyStore.getState().dictWanted).toBe(false);
  });

  it('app: captures the window with redaction, fits it whole, frame in the app theme', async () => {
    const r = await buildSocialExport({ message, options: { ...options, content: 'app', size: 'landscape' } });
    expect(r.ok).toBe(true);
    expect(renderSocialCard).not.toHaveBeenCalled();
    expect(captureAppWindow.mock.calls[0][0].redact).toBe(true);
    expect(captureAppWindow.mock.calls[0][0].dict.size).toBeGreaterThan(0);
    expect(composeSocialImage.mock.calls[0][0]).toMatchObject({ size: SIZE_PRESETS.landscape, theme: 'dark' });
    noLeak(r.file.name);
  });

  it('an own appTheme beats the app theme: the capture and the frame both use it', async () => {
    useThemeStore.setState({ theme: 'dark' });
    await buildSocialExport({ message, options: { ...options, content: 'app', appTheme: 'light' } });
    expect(captureAppWindow.mock.calls[0][0].theme).toBe('light');
    expect(composeSocialImage.mock.calls[0][0].theme).toBe('light');
    await buildSocialExport({ message, options: { ...options, content: 'app', appTheme: null } });
    expect(captureAppWindow.mock.calls[1][0].theme).toBe('dark');
    expect(composeSocialImage.mock.calls[1][0].theme).toBe('dark');
  });

  it('card: the Appearance themes the frame and the header, the Mail theme the body, which follows the Appearance until picked', async () => {
    useThemeStore.setState({ theme: 'dark', palette: 'indigo' });
    await buildSocialExport({ message, options });
    expect(renderSocialCard.mock.calls[0][0]).toMatchObject({ appearance: 'dark', mail: 'dark', palette: 'indigo' });
    expect(composeSocialImage.mock.calls[0][0].theme).toBe('dark');
    // Dark appearance over a light mail, like the app.
    await buildSocialExport({ message, options: { ...options, mailTheme: 'light' } });
    expect(renderSocialCard.mock.calls[1][0]).toMatchObject({ appearance: 'dark', mail: 'light' });
    expect(composeSocialImage.mock.calls[1][0].theme).toBe('dark');
    // Light appearance, dark mail.
    await buildSocialExport({ message, options: { ...options, appTheme: 'light', mailTheme: 'dark' } });
    expect(renderSocialCard.mock.calls[2][0]).toMatchObject({ appearance: 'light', mail: 'dark' });
    expect(composeSocialImage.mock.calls[2][0].theme).toBe('light');
    // An own Appearance with no Mail pick: the mail follows it, not the app.
    await buildSocialExport({ message, options: { ...options, appTheme: 'light', mailTheme: null } });
    expect(renderSocialCard.mock.calls[3][0]).toMatchObject({ appearance: 'light', mail: 'light' });
    useThemeStore.setState({ theme: 'light', palette: 'graphite' });
    await buildSocialExport({ message, options: { ...options, content: 'app' } });
    expect(composeSocialImage.mock.calls[4][0].theme).toBe('light');
  });

  it('redacts while privacy mode is on, even when asked not to', async () => {
    usePrivacyStore.setState({ enabled: true });
    const r = await buildSocialExport({ message, options: { ...options, redact: false } });
    const args = renderSocialCard.mock.calls[0][0];
    noLeak(JSON.stringify(args.message) + args.bodyHtml + r.file.name);
    await buildSocialExport({ message, options: { ...options, content: 'app', redact: false } });
    expect(captureAppWindow.mock.calls[0][0].redact).toBe(true);
  });

  it('without redact, passes the original message through', async () => {
    const r = await buildSocialExport({ message, options: { ...options, redact: false } });
    const args = renderSocialCard.mock.calls[0][0];
    expect(args.message.from).toEqual(FIXTURE_MESSAGE.from);
    expect(args.bodyHtml).toContain('Rokas Ambrazevičius');
    expect(args.redactStyle).toBeUndefined();
    expect(r.file.name).toContain('Joanna Kowalczyk');
  });

  it('reports a failed render instead of throwing', async () => {
    renderSocialCard.mockRejectedValueOnce(new Error('frame'));
    const r = await buildSocialExport({ message, options });
    expect(r).toMatchObject({ ok: false, reason: 'render' });
  });

  it('encodes through toBlob where no worker exists, and reports an encode that gives nothing', async () => {
    const toBlob = vi.fn((cb) => cb(null));
    composeSocialImage.mockReturnValueOnce({ ...stubCanvas(), toBlob });
    const r = await buildSocialExport({ message, options });
    expect(toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/png');
    expect(r).toMatchObject({ ok: false, reason: 'render' });
  });

  it('puts the maker\'s lockup on the saved image, and still saves when it cannot load', async () => {
    await buildSocialExport({ message, options });
    expect(composeSocialImage.mock.calls[0][0].watermark).toBe(MARK);
    loadWatermark.mockResolvedValueOnce(null);
    const r = await buildSocialExport({ message, options });
    expect(r.ok).toBe(true);
    expect(composeSocialImage.mock.calls[1][0].watermark).toBeNull();
  });

  describe('spam sender reveal, sender details and links', () => {
    const spam = {
      uid: 9, subject: 'You won', date: new Date('2026-09-01T10:00:00Z'),
      from: { name: 'Prize Desk', address: 'win@prize.example' },
      to: [{ name: 'Rokas Ambrazevičius', address: 'rokas@example.lt' }],
      replyTo: [{ address: 'collect@elsewhere.example' }],
      authenticationResults: 'mx; spf=fail; dkim=pass; dmarc=pass',
      html: '<p>Hi Rokas Ambrazevičius <a href="http://claim.example/c/rokas%40example.lt">https://bank.example</a></p>',
    };

    it('redacted with revealSender: the sender stays in the header and the file name, everyone else is masked', async () => {
      const r = await buildSocialExport({ message: spam, options: { ...options, revealSender: true } });
      const args = renderSocialCard.mock.calls[0][0];
      expect(args.message.from).toEqual({ name: 'Prize Desk', address: 'win@prize.example' });
      expect(args.message.to[0].address).toBe('xxxxx@xxxxxxx.xx');
      expect(args.message.replyTo[0].address).toBe('collect@elsewhere.example');
      expect(args.bodyHtml).not.toContain('Rokas');
      expect(typeof args.onCloneHead).toBe('function');
      expect(r.file.name).toContain('Prize Desk');
      expect(r.file.name).not.toContain('Rokas');
    });

    it('without revealSender the sender is masked like anyone and nothing special is passed', async () => {
      const r = await buildSocialExport({ message: spam, options });
      const args = renderSocialCard.mock.calls[0][0];
      expect(JSON.stringify(args.message)).not.toMatch(/win@prize|Prize Desk|collect@elsewhere/);
      expect(args.onCloneHead).toBeUndefined();
      expect(r.file.name).not.toContain('Prize');
    });

    it('revealSender never reveals when the image is not redacted (nothing to reveal) or the From is the user', async () => {
      await buildSocialExport({ message: spam, options: { ...options, redact: false, revealSender: true } });
      expect(renderSocialCard.mock.calls[0][0].onCloneHead).toBeUndefined();
      mail.accounts = [{ id: 'acct-1', email: 'WIN@prize.example' }];
      await buildSocialExport({ message: { ...spam, replyTo: undefined }, options: { ...options, revealSender: true } });
      const args = renderSocialCard.mock.calls[1][0];
      expect(args.message.from.address).toBe('xxx@xxxxx.xxxxxxx');
      expect(args.onCloneHead).toBeUndefined();
    });

    it('privacy mode on: still reveals the sender when asked, still redacts everyone else', async () => {
      usePrivacyStore.setState({ enabled: true });
      await buildSocialExport({ message: spam, options: { ...options, redact: false, revealSender: true } });
      const args = renderSocialCard.mock.calls[0][0];
      expect(args.message.from.address).toBe('win@prize.example');
      expect(args.message.to[0].address).toBe('xxxxx@xxxxxxx.xx');
    });

    it('the header pass keeps the revealed name and the From line, and masks the rest of the header', async () => {
      await buildSocialExport({ message: spam, options: { ...options, revealSender: true, senderDetails: true } });
      const { onCloneHead, onCloneNode } = renderSocialCard.mock.calls[0][0];
      const head = document.createElement('div');
      head.innerHTML = '<p>Prize Desk &lt;win@prize.example&gt;</p><p>Prize Desk</p><p>Rokas Ambrazevičius</p>';
      onCloneHead(head);
      expect(head.textContent).toContain('Prize Desk <win@prize.example>Prize Desk');
      expect(head.textContent).not.toContain('Rokas');
      // The body half keeps no exception.
      const body = document.createElement('div');
      body.innerHTML = '<p>Prize Desk</p>';
      onCloneNode(body);
      expect(body.textContent).toBe('xxxxx xxxx');
    });

    it('card: the sender-details box and the links list go to the header, masked', async () => {
      await buildSocialExport({ message: spam, options: { ...options, senderDetails: true, links: true } });
      const { extrasHtml } = renderSocialCard.mock.calls[0][0];
      expect(extrasHtml).toContain('Sender Details');
      expect(extrasHtml).toContain('data-mv-box="links"');
      expect(extrasHtml).toContain('Dangerous'); // the text shows bank.example, it goes to claim.example
      expect(extrasHtml).toContain('http://claim.example');
      expect(extrasHtml).not.toMatch(/win@prize|Prize Desk|collect@elsewhere|rokas|Rokas/i);
      noLeak(extrasHtml);
    });

    it('card without them: no extras at all; unredacted shows the real values', async () => {
      await buildSocialExport({ message: spam, options });
      expect(renderSocialCard.mock.calls[0][0].extrasHtml).toBeUndefined();
      await buildSocialExport({ message: spam, options: { ...options, redact: false, senderDetails: true, links: true } });
      const { extrasHtml } = renderSocialCard.mock.calls[1][0];
      expect(extrasHtml).toContain('win@prize.example');
      expect(extrasHtml).toContain('http://claim.example/c/rokas%40example.lt');
    });

    it('app window: passes the reveal and the open message to the capture, and never the links', async () => {
      await buildSocialExport({ message: spam, options: { ...options, content: 'app', revealSender: true, senderDetails: true, links: true } });
      const args = captureAppWindow.mock.calls[0][0];
      expect([...args.reveal].sort()).toEqual(['collect@elsewhere.example', 'prize desk', 'win@prize.example']);
      expect(args.dict.reveal).toBe(args.reveal);
      expect(args.senderDetails).toEqual({ uid: 9, accountId: 'acct-1', mailbox: 'INBOX' });
      expect(renderSocialCard).not.toHaveBeenCalled();
      await buildSocialExport({ message: spam, options: { ...options, content: 'app' } });
      expect(captureAppWindow.mock.calls[1][0].reveal).toBeUndefined();
      expect(captureAppWindow.mock.calls[1][0].senderDetails).toBeUndefined();
    });
  });
});
