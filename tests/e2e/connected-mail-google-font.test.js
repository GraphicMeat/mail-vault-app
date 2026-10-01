/**
 * E2E: received mail draws in its Google Font, fetched by the daemon.
 *
 * A mail styled in a Google Font links Google's stylesheet. The webview used to
 * fetch it itself: past Network Activity and past tracker blocking. Now
 * `frameBody` strips the link and every @import of it, the app CSP no longer
 * allows Google's hosts, and `attachMailFonts` reads the family the rendered
 * frame names, has the daemon download it (`fonts.download`, unless tracker
 * blocking is on) and registers its faces into the frame's own
 * `document.fonts`. Unit tests mock the daemon and the frame; only this run
 * proves the real webview, the real daemon and the real network agree:
 *
 *   1. a mail naming Lora draws in Lora (a loaded FontFace in the FRAME's
 *      fonts, and a width no Georgia fallback has);
 *   2. the frame holds no Google stylesheet link or @import, while a non-Google
 *      link and @import beside them survive (so the strip is what removed them);
 *   3. the webview cannot load a Google stylesheet into a mail frame (CSP);
 *   4. the download is in Network Activity under purpose "fonts";
 *   5. with tracker blocking on, a family not yet downloaded is not fetched,
 *      while a downloaded one still draws; turned off again, it is fetched.
 *
 * Fixture: two HTML messages appended to yoda's INBOX in `before` (dated 2020,
 * removed in `after`), so no mailbox count another spec reads ever changes.
 * Fonts land under the run's throwaway HOME (app data dir), which
 * `resetAppState` wipes before the next spec file: nothing to remove here.
 *
 * Every value an assertion reads is logged as one `[gfont]` JSON line: the job
 * clone is deleted after the run, so stdout is the only evidence kept.
 */

import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { ImapFlow } from 'imapflow';
import { MOCK_PASSWORD, appDataDir } from './mockImap.js';
import { waitForApp, waitForEmails, switchToFolder, openSettings, closeSettings, clickSettingsNav } from './helpers.js';

const YODA = 'yoda@mock.test';
const YODA_SERVER = 2; // MOCK_ACCOUNTS order: luke, vader, yoda

const LORA_SUBJECT = 'Google font fixture Lora';
const MERRI_SUBJECT = 'Google font fixture Merriweather';
const LORA_MSGID = 'gfont-lora-fixture';
const MERRI_MSGID = 'gfont-merriweather-fixture';

const LORA_ID = 'mv-gfont-lora';
const LORA_PROBE = 'mv-gfont-lora-probe';
const GEORGIA_PROBE = 'mv-gfont-georgia-probe';
const MERRI_ID = 'mv-gfont-merri';
const LORA2_PROBE = 'mv-gfont-lora2-probe';
const CONTROL_HOST = 'mv-control.invalid';
const PROBE_TEXT = 'Sphinx of black quartz, judge my vow 0123456789';
const PROBE_STYLE = 'font-size: 24px; white-space: nowrap; display: inline-block';
const PREMIUM = { hasSubscription: true, premiumAccess: true, status: 'active', clientAccessGranted: true };

const log = (tag, value) => console.log(`[gfont] ${tag} ${JSON.stringify(value)}`);

function htmlMail({ subject, messageId, from, day, html }) {
  const boundary = 'MvGoogleFontBoundary';
  return Buffer.from([
    `From: ${from}`,
    `To: ${YODA}`,
    `Subject: ${subject}`,
    `Date: ${day} Jan 2020 12:00:00 +0000`,
    `Message-ID: <${messageId}@mock.test>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    '',
    'A mail written in a Google Font.',
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    '',
    html,
    '',
    `--${boundary}--`,
    '',
  ].join('\r\n'));
}

// The Google link and @import, each with a non-Google twin that must survive.
const loraMail = () => htmlMail({
  subject: LORA_SUBJECT,
  messageId: LORA_MSGID,
  from: 'Lora Letters <letters@lora-fixture.test>',
  day: 'Thu, 02',
  html: '<link href="https://fonts.googleapis.com/css2?family=Lora:wght@400;700&display=swap" rel="stylesheet">'
    + `<link rel="stylesheet" href="https://${CONTROL_HOST}/a.css">`
    + '<style>'
    + "@import url('https://fonts.googleapis.com/css2?family=Lora&display=swap');"
    + `@import url('https://${CONTROL_HOST}/b.css');`
    + '.mv-gfont-marker { letter-spacing: 0; }'
    + '</style>'
    + `<p id="${LORA_ID}" style="font-family: 'Lora', Georgia, serif">This paragraph is written in Lora.</p>`
    + `<p><span id="${LORA_PROBE}" style="font-family: 'Lora', Georgia, serif; ${PROBE_STYLE}">${PROBE_TEXT}</span></p>`
    + `<p><span id="${GEORGIA_PROBE}" style="font-family: Georgia, serif; ${PROBE_STYLE}">${PROBE_TEXT}</span></p>`,
});

const merriMail = () => htmlMail({
  subject: MERRI_SUBJECT,
  messageId: MERRI_MSGID,
  from: 'Merri Weather <news@merri-fixture.test>',
  day: 'Fri, 03',
  html: `<p id="${MERRI_ID}" style="font-family: 'Merriweather', Georgia, serif">This paragraph is written in Merriweather.</p>`
    + `<p><span id="${LORA2_PROBE}" style="font-family: 'Lora', Georgia, serif; ${PROBE_STYLE}">${PROBE_TEXT}</span></p>`,
});

async function inInbox(fn) {
  const { host, port } = browser.mockImap[YODA_SERVER];
  const client = new ImapFlow({ host, port, secure: false, auth: { user: YODA, pass: MOCK_PASSWORD }, logger: false });
  await client.connect();
  const lock = await client.getMailboxLock('INBOX');
  try {
    return await fn(client);
  } finally {
    lock.release();
    await client.logout();
  }
}

/** `browser.execute` does not await a Promise; `executeAsync` does. */
const rpc = (method, params = {}) => browser.executeAsync((m, p, done) => {
  window.__TAURI__.core.invoke('daemon_rpc', { method: m, params: p })
    .then(done).catch((e) => done({ __error: String((e && e.message) || e) }));
}, method, params);

async function fontList() {
  const answer = await rpc('fonts.list');
  if (answer?.__error) throw new Error(`fonts.list failed: ${answer.__error}`);
  return {
    installed: (answer?.fonts || []).map((f) => f.family),
    downloading: answer?.downloading || [],
  };
}

async function openRow(subject) {
  await browser.waitUntil(() => browser.execute((needle) => {
    const row = [...document.querySelectorAll('[data-testid="email-row"]')]
      .find((r) => r.offsetHeight > 0 && (r.innerText || '').includes(needle));
    row?.click();
    return !!row;
  }, subject), { timeout: 60_000, interval: 500, timeoutMsg: `no row for "${subject}" in ${YODA}'s INBOX` });
}

/**
 * The fonts state of the mail frame holding `markerId`: every FontFace in the
 * frame's own document.fonts, `fonts.check` for `family`, and the widths of
 * two same-text spans (the family's stack and plain Georgia).
 */
const readFonts = (markerId, family, probeId, controlId) => browser.execute((id, fam, probe, control) => {
  const frame = [...document.querySelectorAll('iframe')].find((f) => {
    try { return !!f.contentDocument?.getElementById(id); } catch { return false; }
  });
  const doc = frame?.contentDocument;
  if (!doc) return null;
  const faces = [];
  doc.fonts.forEach((f) => faces.push({ family: f.family.replace(/^["']|["']$/g, ''), status: f.status, weight: f.weight, style: f.style }));
  const width = (el) => (el ? Math.round(el.getBoundingClientRect().width * 100) / 100 : null);
  let check = null;
  try { check = doc.fonts.check(`16px ${fam}`); } catch (e) { check = `threw ${e.message}`; }
  return {
    readyState: doc.readyState,
    faces,
    familyLoaded: faces.filter((f) => f.family === fam && f.status === 'loaded').length,
    check,
    probeWidth: width(doc.getElementById(probe)),
    controlWidth: width(control ? doc.getElementById(control) : null),
    computedFamily: doc.defaultView.getComputedStyle(doc.getElementById(id)).fontFamily,
  };
}, markerId, family, probeId, controlId || '');

describe('Received mail draws in its Google Font, through the daemon', function () {
  this.timeout(300_000);

  let priorSettings = null;

  before(async function () {
    await waitForApp();
    await waitForEmails();

    // Precondition: neither family is here yet, so whatever loads below was
    // downloaded by this run.
    const list = await fontList();
    log('precondition fonts.list', list);
    expect(list.installed).not.toContain('Lora');
    expect(list.installed).not.toContain('Merriweather');
    expect(list.installed).not.toContain('Lato');

    await inInbox(async (client) => {
      await client.append('INBOX', loraMail(), ['\\Seen'], new Date('2020-01-02T12:00:00Z'));
      await client.append('INBOX', merriMail(), ['\\Seen'], new Date('2020-01-03T12:00:00Z'));
    });
    await switchToFolder(YODA, 'INBOX');
    await openRow(LORA_SUBJECT);
  });

  after(async function () {
    try {
      if (priorSettings) {
        await browser.execute((prior) => window.__SETTINGS_STORE__.setState(prior), priorSettings);
      }
    } catch { /* app already gone */ }
    try {
      await inInbox(async (client) => {
        for (const id of [LORA_MSGID, MERRI_MSGID]) {
          const uids = await client.search({ header: { 'message-id': `<${id}@mock.test>` } }, { uid: true });
          if (uids.length) await client.messageDelete(uids, { uid: true });
        }
      });
    } catch (e) {
      console.warn('[gfont] could not purge the fixtures:', e.message);
    }
  });

  it('draws the mail in Lora, downloaded by the daemon and registered in the frame', async function () {
    let frame = null;
    try {
      await browser.waitUntil(async () => {
        frame = await readFonts(LORA_ID, 'Lora', LORA_PROBE, GEORGIA_PROBE);
        return !!frame && frame.familyLoaded > 0 && frame.probeWidth !== frame.controlWidth;
      }, { timeout: 45_000, interval: 500 });
    } finally {
      log('lora frame', frame);
      log('lora fonts.list', await fontList().catch((e) => e.message));
    }
    expect(frame.familyLoaded).toBeGreaterThan(0);
    expect(frame.check).toBe(true);
    // Same text, same size: Lora's advance widths are not Georgia's.
    expect(Math.abs(frame.probeWidth - frame.controlWidth)).toBeGreaterThan(3);

    const list = await fontList();
    expect(list.installed).toContain('Lora');
    // Under the run's own HOME, which resetAppState wipes per spec file.
    const root = join(appDataDir(browser.testDataDir), 'fonts');
    const onDisk = existsSync(root) ? readdirSync(root) : null;
    log('fonts dir', { root, onDisk });
    expect(onDisk).not.toBe(null);
  });

  it('leaves no Google Fonts link or @import in the frame, and keeps the non-Google ones', async function () {
    const doc = await browser.execute((id, controlHost) => {
      const frame = [...document.querySelectorAll('iframe')].find((f) => {
        try { return !!f.contentDocument?.getElementById(id); } catch { return false; }
      });
      const d = frame?.contentDocument;
      if (!d) return null;
      const own = [...d.querySelectorAll('style:not(.darkreader)')].map((s) => s.textContent || '');
      return {
        googleLinks: [...d.querySelectorAll('link[href*="fonts.googleapis.com"], link[href*="fonts.gstatic.com"]')].map((l) => l.outerHTML),
        googleImports: own.filter((css) => /@import[^;]*fonts\.(googleapis|gstatic)\.com/i.test(css)),
        controlLinks: [...d.querySelectorAll(`link[href*="${controlHost}"]`)].map((l) => l.outerHTML),
        controlImports: own.filter((css) => css.includes(`${controlHost}/b.css`)).length,
        markerStyle: own.some((css) => css.includes('.mv-gfont-marker')),
      };
    }, LORA_ID, CONTROL_HOST);
    log('strip', doc);
    expect(doc).not.toBe(null);
    // Positive controls: the same body's non-Google link and @import reached
    // the frame, so nothing upstream drops every link or @import.
    expect(doc.markerStyle).toBe(true);
    expect(doc.controlLinks.length).toBe(1);
    expect(doc.controlImports).toBe(1);
    expect(doc.googleLinks).toEqual([]);
    expect(doc.googleImports).toEqual([]);
  });

  it('cannot load a Google stylesheet into a mail frame (CSP)', async function () {
    const injected = await browser.execute((id) => {
      const frame = [...document.querySelectorAll('iframe')].find((f) => {
        try { return !!f.contentDocument?.getElementById(id); } catch { return false; }
      });
      const d = frame?.contentDocument;
      if (!d) return null;
      const win = d.defaultView;
      win.__mvProbe = { violations: [], google: 'pending', self: 'pending' };
      d.addEventListener('securitypolicyviolation', (e) => {
        win.__mvProbe.violations.push({ blockedURI: e.blockedURI, directive: e.effectiveDirective || e.violatedDirective });
      });
      const add = (href, key) => {
        const link = d.createElement('link');
        link.rel = 'stylesheet';
        link.href = href;
        link.dataset.mvProbe = key;
        link.addEventListener('load', () => { win.__mvProbe[key] = 'load'; });
        link.addEventListener('error', () => { win.__mvProbe[key] = 'error'; });
        d.head.appendChild(link);
      };
      add('https://fonts.googleapis.com/css2?family=Lato', 'google');
      // Positive control: a stylesheet the CSP allows ('self') loads into the
      // same frame the same way, so an injected link CAN load here.
      const selfHref = document.querySelector('link[rel="stylesheet"]')?.href || null;
      if (selfHref) add(selfHref, 'self'); else win.__mvProbe.self = 'no app stylesheet';
      const span = d.createElement('span');
      span.id = 'mv-gfont-lato-probe';
      span.style.cssText = "font-family: 'Lato', Georgia, serif; font-size: 24px; white-space: nowrap; display: inline-block";
      span.textContent = 'Sphinx of black quartz, judge my vow 0123456789';
      const control = d.createElement('span');
      control.id = 'mv-gfont-lato-control';
      control.style.cssText = 'font-family: Georgia, serif; font-size: 24px; white-space: nowrap; display: inline-block';
      control.textContent = span.textContent;
      d.body.append(span, control);
      return { selfHref };
    }, LORA_ID);
    expect(injected).not.toBe(null);

    const readProbe = () => browser.execute((id) => {
      const frame = [...document.querySelectorAll('iframe')].find((f) => {
        try { return !!f.contentDocument?.getElementById(id); } catch { return false; }
      });
      const d = frame?.contentDocument;
      if (!d) return null;
      const link = d.querySelector('link[data-mv-probe="google"]');
      let rules = 'no sheet';
      if (link?.sheet) { try { rules = link.sheet.cssRules.length; } catch (e) { rules = `unreadable: ${e.name}`; } }
      const faces = [];
      d.fonts.forEach((f) => faces.push({ family: f.family.replace(/^["']|["']$/g, ''), status: f.status }));
      const w = (el) => (el ? Math.round(el.getBoundingClientRect().width * 100) / 100 : null);
      let check = null;
      try { check = d.fonts.check('16px Lato'); } catch (e) { check = `threw ${e.message}`; }
      return {
        ...d.defaultView.__mvProbe,
        googleSheet: !!link?.sheet,
        googleRules: rules,
        latoFaces: faces.filter((f) => /lato/i.test(f.family)),
        // Dark Reader may fetch a cross-origin sheet's text itself and inline it.
        drGoogleStyles: [...d.querySelectorAll('style')].filter((s) => /Lato|gstatic|googleapis/.test(s.textContent || '')).map((s) => (s.className || '(no class)') + ': ' + (s.textContent || '').slice(0, 160)),
        latoCheck: check,
        latoWidth: w(d.getElementById('mv-gfont-lato-probe')),
        georgiaWidth: w(d.getElementById('mv-gfont-lato-control')),
      };
    }, LORA_ID);

    let probe = null;
    try {
      await browser.waitUntil(async () => {
        probe = await readProbe();
        return !!probe && probe.google !== 'pending' && probe.self !== 'pending';
      }, { timeout: 6_000, interval: 300 });
    } catch { /* a link that never settles is also "not loaded"; read once more below */ }
    await browser.pause(2000); // let any late font load settle before the final read
    probe = await readProbe();
    log('csp probe', { ...injected, ...probe });

    expect(probe).not.toBe(null);
    if (injected.selfHref) expect(probe.self).toBe('load');
    expect(probe.google).not.toBe('load');
    expect(probe.googleSheet).toBe(false);
    expect(probe.latoFaces.filter((f) => f.status === 'loaded')).toEqual([]);
    // The download path must not have been taken for an injected family either.
    const list = await fontList();
    log('csp probe fonts.list', list);
    expect(list.installed).not.toContain('Lato');
    expect(list.downloading).not.toContain('Lato');
  });

  it('lists the daemon download in Network Activity under purpose "fonts"', async function () {
    const tableRows = () => browser.execute(() =>
      [...document.querySelectorAll('[data-testid="net-row"]')].map((row) => ({
        host: row.getAttribute('data-host'),
        purpose: row.children[5]?.innerText.trim() || '',
        account: row.querySelector('[data-testid="net-account"]')?.innerText.trim() || '',
      })));
    const choose = (label, value) => browser.execute((name, wanted) => {
      const select = document.querySelector(`[data-testid="network-activity"] select[aria-label="${name}"]`);
      if (!select || ![...select.options].some((o) => o.value === wanted)) return false;
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, wanted);
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }, label, value);

    await openSettings();
    try {
      await clickSettingsNav('Privacy & security');
      await clickSettingsNav('Network Activity');
      let rows = [];
      let filtered = false;
      try {
        await browser.waitUntil(async () => {
          if (!filtered) filtered = await choose('Purpose', 'fonts');
          rows = await tableRows();
          return rows.some((r) => /^fonts\.(googleapis|gstatic)\.com$/.test(r.host) && r.purpose === 'Fonts');
        }, { timeout: 30_000, interval: 1000 });
      } finally {
        log('net activity', { filtered, rows: rows.filter((r) => /fonts/.test(r.host) || r.purpose === 'Fonts'), total: rows.length });
      }
      const fontRows = rows.filter((r) => r.purpose === 'Fonts');
      expect(fontRows.some((r) => /^fonts\.(googleapis|gstatic)\.com$/.test(r.host))).toBe(true);
      // Only Google's font hosts are ever contacted for fonts.
      expect(fontRows.every((r) => /^fonts\.(googleapis|gstatic)\.com$/.test(r.host))).toBe(true);
    } finally {
      try { await choose('Purpose', ''); } catch { /* page gone */ }
      await closeSettings();
    }
  });

  it('with tracker blocking on, draws a downloaded family but fetches no new one', async function () {
    const before = await fontList();
    log('blocking precondition fonts.list', before);
    expect(before.installed).toContain('Lora');
    expect(before.installed).not.toContain('Merriweather');

    priorSettings = await browser.execute(() => {
      const s = window.__SETTINGS_STORE__.getState();
      return { billingProfile: s.billingProfile ?? null, trackerBlockingEnabled: !!s.trackerBlockingEnabled };
    });
    const on = await browser.execute((billing) => {
      window.__SETTINGS_STORE__.setState({ billingProfile: billing, trackerBlockingEnabled: true });
      const s = window.__SETTINGS_STORE__.getState();
      return { trackerBlockingEnabled: s.trackerBlockingEnabled, premiumAccess: s.billingProfile?.premiumAccess };
    }, PREMIUM);
    log('blocking on', on);
    expect(on.trackerBlockingEnabled).toBe(true);

    await openRow(MERRI_SUBJECT);
    let frame = null;
    try {
      await browser.waitUntil(async () => {
        frame = await readFonts(MERRI_ID, 'Lora', LORA2_PROBE, null);
        return !!frame && frame.familyLoaded > 0;
      }, { timeout: 30_000, interval: 500 });
    } finally {
      log('blocking frame (Lora)', frame);
    }
    // The downloaded family still draws: proves this document was scanned.
    expect(frame.familyLoaded).toBeGreaterThan(0);

    // Give a download every chance to start, then prove none did.
    await browser.pause(10_000);
    const merri = await readFonts(MERRI_ID, 'Merriweather', MERRI_ID, null);
    const after = await fontList();
    log('blocking after 10s', { merriFaces: merri?.faces?.filter((f) => f.family === 'Merriweather'), fontsList: after });
    expect(after.installed).not.toContain('Merriweather');
    expect(after.downloading).not.toContain('Merriweather');
    expect(merri.faces.filter((f) => f.family === 'Merriweather')).toEqual([]);

    // Control: blocking off, the same mail reopened downloads Merriweather.
    // Without this, "not fetched" could mean the scan never saw the family.
    await browser.execute((prior) => window.__SETTINGS_STORE__.setState(prior), priorSettings);
    await openRow(LORA_SUBJECT);
    await browser.waitUntil(() => browser.execute((id) => [...document.querySelectorAll('iframe')]
      .some((f) => { try { return !!f.contentDocument?.getElementById(id); } catch { return false; } }), LORA_ID),
    { timeout: 30_000, interval: 500, timeoutMsg: 'the Lora mail never reopened' });
    await openRow(MERRI_SUBJECT);
    let control = null;
    try {
      await browser.waitUntil(async () => {
        control = await readFonts(MERRI_ID, 'Merriweather', MERRI_ID, null);
        return !!control && control.familyLoaded > 0;
      }, { timeout: 45_000, interval: 500 });
    } finally {
      log('blocking off control', { control, fontsList: await fontList().catch((e) => e.message) });
    }
    expect(control.familyLoaded).toBeGreaterThan(0);
    expect((await fontList()).installed).toContain('Merriweather');
  });
});
