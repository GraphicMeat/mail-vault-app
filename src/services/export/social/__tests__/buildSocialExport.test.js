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
// The link verdicts are the daemon's (`body.classify_links`), answered as it answers this link.
vi.mock('../../../bodyScan', async (orig) => (await import('../../../../test/bodyScan')).stubLinkVerdicts(orig, {
  'http://claim.example/c/rokas%40example.lt': 'red',
}));
vi.mock('../../renderMessageToCanvas', () => ({
  renderMessageToCanvas: vi.fn(async () => stubCanvas()),
  measureMessageHeight: vi.fn(async () => 100),
}));
vi.mock('../captureAppWindow', () => ({ captureAppWindow: (...a) => captureAppWindow(...a) }));
vi.mock('../composeSocialImage', () => ({ composeSocialImage: (...a) => composeSocialImage(...a) }));
const MARK = { icon: { naturalWidth: 256, naturalHeight: 256 }, mark: { naturalWidth: 478, naturalHeight: 84 } };
const loadBrand = vi.fn(async () => MARK);
vi.mock('../socialWatermark', () => ({ loadBrand: (...a) => loadBrand(...a), loadWatermark: async () => MARK }));
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

const { buildSocialExport, buildSocialContent } = await import('../buildSocialExport');
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

  it('card: renders at the Email width it is given, the width the preview showed', async () => {
    await buildSocialExport({ message, options: { ...options, width: 1200 } });
    expect(renderSocialCard.mock.calls[0][0].width).toBe(1200);
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

  it('app: the reader is shot in the Mail theme, which follows the Appearance until picked', async () => {
    useThemeStore.setState({ theme: 'dark' });
    await buildSocialExport({ message, options: { ...options, content: 'app' } });
    expect(captureAppWindow.mock.calls[0][0].mailTheme).toBe('dark');
    await buildSocialExport({ message, options: { ...options, content: 'app', mailTheme: 'light' } });
    expect(captureAppWindow.mock.calls[1][0]).toMatchObject({ theme: 'dark', mailTheme: 'light' });
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

  it('puts the brand on the saved image, and still saves when it cannot load', async () => {
    await buildSocialExport({ message, options });
    expect(composeSocialImage.mock.calls[0][0].watermark).toBe(MARK);
    loadBrand.mockResolvedValueOnce(null);
    const r = await buildSocialExport({ message, options });
    expect(r.ok).toBe(true);
    expect(composeSocialImage.mock.calls[1][0].watermark).toBeNull();
  });

  it('loads the brand the style picked: none, an own image, or (absent) the default', async () => {
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    await buildSocialExport({ message, options: { ...options, brand: 'image', brandImage: png } });
    expect(loadBrand).toHaveBeenLastCalledWith(expect.objectContaining({ brand: 'image', brandImage: png }));
    await buildSocialExport({ message, options: { ...options, brand: 'none' } });
    expect(loadBrand).toHaveBeenLastCalledWith(expect.objectContaining({ brand: 'none' }));
  });

  it('hideTo reaches the card render and the app capture, and is off otherwise', async () => {
    await buildSocialExport({ message, options: { ...options, hideTo: true } });
    expect(renderSocialCard.mock.calls[0][0].hideTo).toBe(true);
    await buildSocialExport({ message, options: { ...options, content: 'app', hideTo: true } });
    expect(captureAppWindow.mock.calls[0][0].hideTo).toBe(true);
    renderSocialCard.mockClear();
    await buildSocialExport({ message, options });
    expect(renderSocialCard.mock.calls[0][0].hideTo).toBeFalsy();
  });

  describe('word marks: a click on the image', () => {
    const plain = { ...options, redact: false };

    it('show leaves a detected word readable in the header and the body, the rest stays masked', async () => {
      await buildSocialExport({ message, options: { ...options, marks: { 'joanna.k@example.org': 'show' } } });
      const args = renderSocialCard.mock.calls[0][0];
      expect(args.message.from.address).toBe('joanna.k@example.org');
      expect(args.bodyHtml).toContain('joanna.k@example.org');
      expect(args.bodyHtml).not.toContain('Rokas');
      expect(args.bodyHtml).not.toContain('612 34567');
      expect(args.message.from.name).not.toContain('Joanna');
    });

    it('hide masks a word the detector missed, in the body and the header', async () => {
      await buildSocialExport({ message: { ...message, subject: 'Project Falcon update', html: '<p>Falcon flies</p>' }, options: { ...options, marks: { falcon: 'hide' } } });
      const args = renderSocialCard.mock.calls[0][0];
      expect(args.bodyHtml).not.toContain('Falcon');
      expect(args.message.subject).not.toContain('Falcon');
    });

    it('hide works with the redact box off: only that word is masked, nothing else is detected', async () => {
      const r = await buildSocialExport({ message: { ...message, html: '<p>Falcon flies, mail joanna.k@example.org</p>' }, options: { ...plain, marks: { falcon: 'hide' } } });
      expect(r.ok).toBe(true);
      const args = renderSocialCard.mock.calls[0][0];
      expect(args.bodyHtml).not.toContain('Falcon');
      expect(args.bodyHtml).toContain('joanna.k@example.org');
      expect(args.message.from.address).toBe('joanna.k@example.org');
      expect(args.redactStyle).toBe('blur');
      expect(typeof args.onCloneNode).toBe('function');
    });

    it('show with the redact box off changes nothing, and no marks leaves the card unredacted as before', async () => {
      await buildSocialExport({ message, options: { ...plain, marks: { rokas: 'show' } } });
      let args = renderSocialCard.mock.calls[0][0];
      expect(args.redactStyle).toBeUndefined();
      expect(args.onCloneNode).toBeUndefined();
      expect(args.bodyHtml).toContain('Rokas');
      renderSocialCard.mockClear();
      await buildSocialExport({ message, options: plain });
      args = renderSocialCard.mock.calls[0][0];
      expect(args.onCloneNode).toBeUndefined();
    });

    it('the file name hides what the image hides, and a show mark never reaches it', async () => {
      const shown = await buildSocialExport({ message, options: { ...options, marks: { joanna: 'show', kowalczyk: 'show' } } });
      noLeak(shown.file.name);
      const hid = await buildSocialExport({ message: { ...message, subject: 'Project Falcon' }, options: { ...plain, marks: { falcon: 'hide' } } });
      expect(hid.file.name).not.toContain('Falcon');
    });

    it('the app window takes the marks too: the live masking follows them, and a hide mark masks with the redact box off', async () => {
      await buildSocialExport({ message, options: { ...options, content: 'app', marks: { 'joanna.k@example.org': 'show', falcon: 'hide' } } });
      let args = captureAppWindow.mock.calls[0][0];
      expect([...args.dict.show]).toEqual(['joanna.k@example.org']);
      expect([...args.dict.hide]).toEqual(['falcon']);
      expect(args.redact).toBe(true);
      expect(args.wantWords).toBe(false); // a saved image maps no words
      captureAppWindow.mockClear();
      await buildSocialExport({ message, options: { ...plain, content: 'app', marks: { falcon: 'hide' } } });
      args = captureAppWindow.mock.calls[0][0];
      expect(args.redact).toBe(true);
      expect(args.dict).toMatchObject({ detect: false });
      expect([...args.dict.hide]).toEqual(['falcon']);
      captureAppWindow.mockClear();
      await buildSocialExport({ message, options: { ...plain, content: 'app', marks: { rokas: 'show' } } });
      expect(captureAppWindow.mock.calls[0][0].redact).toBe(false);
    });

    it('the preview\'s app shot asks for the hit map', async () => {
      await buildSocialContent(message, { content: 'app', redact: true, theme: 'light' });
      expect(captureAppWindow.mock.calls[0][0].wantWords).toBe(true);
    });

    it('a saved image maps no words; the preview\'s content does, resolved to keys and mask state', async () => {
      await buildSocialExport({ message, options });
      expect(renderSocialCard.mock.calls[0][0].wantWords).toBe(false);
      expect(renderSocialCard.mock.calls[0][0].bodyHtml).not.toContain('data-mv-i');
      renderSocialCard.mockImplementationOnce(async () => ({
        ...stubCanvas(),
        mvRaw: { head: [], body: [
          { mask: 0, ti: 1, text: 'xxxxxxxxxxxxx', rects: [[1, 2, 3, 4]] },
          { mask: null, ti: 0, text: 'mail', rects: [[5, 6, 7, 8]] },
        ] },
      }));
      const content = await buildSocialContent(message, { content: 'card', redact: true, theme: 'light' });
      expect(renderSocialCard.mock.calls.at(-1)[0].wantWords).toBe(true);
      expect(renderSocialCard.mock.calls.at(-1)[0].bodyHtml).toContain('data-mv-i="0"');
      expect(content.mvWords).toEqual([
        { k: 'ambrazevičius', on: true, rects: [[1, 2, 3, 4]] },
        { k: 'mail', on: false, rects: [[5, 6, 7, 8]] },
      ]);
      expect(content).not.toHaveProperty('mvRaw');
    });

    it('a card with no measured words (the alternative renderer) has no hit map', async () => {
      const content = await buildSocialContent(message, { content: 'card', redact: true, theme: 'light' });
      expect(content).not.toHaveProperty('mvWords');
    });
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

    // What the header's safety-net pass leaves of the sender's name: no exception without a reveal.
    const headPass = (args) => {
      const head = document.createElement('div');
      head.innerHTML = '<p>Prize Desk</p>';
      args.onCloneHead(head);
      return head.textContent;
    };

    it('without revealSender the sender is masked like anyone and nothing special is passed', async () => {
      const r = await buildSocialExport({ message: spam, options });
      const args = renderSocialCard.mock.calls[0][0];
      expect(JSON.stringify(args.message)).not.toMatch(/win@prize|Prize Desk|collect@elsewhere/);
      expect(headPass(args)).toBe('xxxxx xxxx');
      expect(r.file.name).not.toContain('Prize');
    });

    it('revealSender never reveals when the image is not redacted (nothing to reveal) or the From is the user', async () => {
      await buildSocialExport({ message: spam, options: { ...options, redact: false, revealSender: true } });
      expect(renderSocialCard.mock.calls[0][0].onCloneHead).toBeUndefined();
      mail.accounts = [{ id: 'acct-1', email: 'WIN@prize.example' }];
      await buildSocialExport({ message: { ...spam, replyTo: undefined }, options: { ...options, revealSender: true } });
      const args = renderSocialCard.mock.calls[1][0];
      expect(args.message.from.address).toBe('xxx@xxxxx.xxxxxxx');
      expect(headPass(args)).toBe('xxxxx xxxx');
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

    it('the header pass leaves the pre-masked boxes alone: a label sharing a name token stays readable', async () => {
      for (const revealSender of [false, true]) {
        renderSocialCard.mockClear();
        await buildSocialExport({ message: spam, options: { ...options, revealSender, senderDetails: true } });
        const { onCloneHead } = renderSocialCard.mock.calls[0][0];
        const head = document.createElement('div');
        // "Desk" is a token of the sender's name: in the header it is masked, in a box label it is ours.
        head.innerHTML = '<p>Rokas Ambrazevičius</p><section data-mv-box="sender"><h2>Desk Details</h2></section><p>Desk</p>';
        onCloneHead(head);
        expect(head.querySelector('[data-mv-box] h2').textContent, String(revealSender)).toBe('Desk Details');
        expect(head.textContent).not.toContain('Rokas');
        expect(head.lastElementChild.textContent).toBe('xxxx');
        expect(head.children[1].matches('[data-mv-box]')).toBe(true);
      }
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

    it('app window: passes the reveal (addresses only) and the open message to the capture, and never the links', async () => {
      await buildSocialExport({ message: spam, options: { ...options, content: 'app', revealSender: true, senderDetails: true, links: true } });
      const args = captureAppWindow.mock.calls[0][0];
      // No name: in the live UI it would unmask every row naming it, a real contact's too.
      expect([...args.reveal].sort()).toEqual(['collect@elsewhere.example', 'win@prize.example']);
      expect(args.dict.reveal).toBe(args.reveal);
      expect(args.senderDetails).toEqual({ uid: 9, accountId: 'acct-1', mailbox: 'INBOX' });
      expect(renderSocialCard).not.toHaveBeenCalled();
      await buildSocialExport({ message: spam, options: { ...options, content: 'app' } });
      expect(captureAppWindow.mock.calls[1][0].reveal).toBeUndefined();
      expect(captureAppWindow.mock.calls[1][0].senderDetails).toBeUndefined();
    });
  });
});
