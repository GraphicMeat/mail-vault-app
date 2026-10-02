import { describe, it, expect } from 'vitest';
import { senderDetailsModel, maskSenderDetails, senderDetailsHtml } from '../senderDetails';
import { buildNameDictionary } from '../../../../utils/privacy/piiDetector';

const spoof = {
  from: { name: 'Prize Desk', address: 'win@prize.example' },
  replyTo: [{ address: 'collect@elsewhere.example' }],
  authenticationResults: 'mx.example; spf=softfail; dkim=pass; dmarc=fail',
};

describe('senderDetailsModel', () => {
  it('reads the address, the name, the issues, the results and the Reply-To as the popover does', () => {
    const m = senderDetailsModel(spoof);
    expect(m.address).toBe('win@prize.example');
    expect(m.name).toBe('Prize Desk');
    expect(m.auth).toEqual({ spf: 'softfail', dkim: 'pass', dmarc: 'fail' });
    expect(m.replyTo).toEqual({ address: 'collect@elsewhere.example', matches: false });
    // The Reply-To mismatch is a warning, the failed SPF/DMARC a danger: both, in that order of discovery.
    expect(m.issues.map(i => i.level).sort()).toEqual(['danger', 'warning']);
    expect(m.issues.find(i => i.level === 'warning').text).toContain('collect@elsewhere.example');
    expect(m.issues.find(i => i.level === 'danger').text).toMatch(/SPF, DMARC/);
    expect(Object.keys(m.issues[0]).sort()).toEqual(['level', 'text']);
    expect(m.noData).toBe(false);
  });

  it('shows the name only when it differs from the address', () => {
    expect(senderDetailsModel({ from: { name: 'a@x.example', address: 'a@x.example' } }).name).toBeNull();
    expect(senderDetailsModel({ from: { address: 'a@x.example' } }).name).toBeNull();
  });

  it('a Reply-To on the sender\'s domain matches; a lone object is read like an array', () => {
    const m = senderDetailsModel({ from: { address: 'a@x.example' }, replyTo: { address: 'b@X.example' }, authenticationResults: 'spf=pass' });
    expect(m.replyTo).toEqual({ address: 'b@X.example', matches: true });
    expect(m.issues).toEqual([]);
  });

  it('no results and no issues is the "no authentication data" case', () => {
    const m = senderDetailsModel({ from: { address: 'a@x.example' } });
    expect(m).toMatchObject({ auth: null, issues: [], replyTo: null, noData: true });
  });

  it('results with no failure keep the box without issues; an info-level issue never counts', () => {
    const m = senderDetailsModel({ from: { address: 'a@x.example' }, returnPath: 'bounce@other.example', authenticationResults: 'spf=pass dkim=pass' });
    expect(m.issues).toEqual([]);
    expect(m.auth).toEqual({ spf: 'pass', dkim: 'pass', dmarc: null });
    // Only an info issue and no results: still "no data" (the popover filters to danger/warning too).
    expect(senderDetailsModel({ from: { address: 'a@x.example' }, returnPath: 'bounce@other.example' }).noData).toBe(true);
  });

  it('a message with no sender does not throw', () => {
    expect(senderDetailsModel({}).address).toBe('unknown');
  });
});

describe('maskSenderDetails', () => {
  const dict = buildNameDictionary({ names: ['Prize Desk', 'Rokas Ambrazevičius'] });
  // Issue lines as senderCheck builds them: catalog text around the From name,
  // the addresses and the From domain. Nothing else in them names anyone.
  const model = {
    ...senderDetailsModel(spoof),
    issues: [
      { level: 'warning', text: 'Reply-To address (collect@elsewhere.example) differs from sender' },
      { level: 'danger', text: 'Display name "Prize Desk" but sent from win@prize.example via prize.example' },
    ],
  };

  it('masks the address, the name, the Reply-To and the values quoted in an issue', () => {
    const m = maskSenderDetails(model, dict);
    expect(m.address).toBe('xxx@xxxxx.xxxxxxx');
    expect(m.name).toBe('xxxxx xxxx');
    expect(m.replyTo).toEqual({ address: 'xxxxxxx@xxxxxxxxx.xxxxxxx', matches: false });
    expect(m.issues[0].text).toBe('Reply-To address (xxxxxxx@xxxxxxxxx.xxxxxxx) differs from sender');
    expect(m.issues[1].text).toBe('Display name "xxxxx xxxx" but sent from xxx@xxxxx.xxxxxxx via xxxxx.xxxxxxx');
    expect(m.auth).toEqual(model.auth);
    expect(JSON.stringify(m)).not.toMatch(/win@|prize|collect@|Prize/);
  });

  it('leaves exactly the revealed values readable, in the fields and in the issue lines', () => {
    const m = maskSenderDetails(model, { ...dict, reveal: new Set(['win@prize.example', 'prize desk', 'collect@elsewhere.example']) });
    expect(m.address).toBe('win@prize.example');
    expect(m.name).toBe('Prize Desk');
    expect(m.replyTo.address).toBe('collect@elsewhere.example');
    expect(m.issues[0].text).toBe('Reply-To address (collect@elsewhere.example) differs from sender');
    expect(m.issues[1].text).toBe('Display name "Prize Desk" but sent from win@prize.example via prize.example');
  });

  it('never masks the catalog words of an issue, even when a known name shares one', () => {
    const sender = buildNameDictionary({ names: ['Verified Sender', 'Authentication Smith'] });
    const m = maskSenderDetails({ ...model, issues: [{ level: 'danger', text: 'Sender authentication failed (SPF, DMARC)' }] }, sender);
    expect(m.issues[0].text).toBe('Sender authentication failed (SPF, DMARC)');
  });

  it('reveals nothing that is not in the set (the sender\'s own address stays masked)', () => {
    const m = maskSenderDetails(model, { ...dict, reveal: new Set(['someone@else.example']) });
    expect(m.address).toBe('xxx@xxxxx.xxxxxxx');
  });
});

describe('senderDetailsHtml', () => {
  it('renders the popover\'s sections with its labels, colours and the Reply-To row', () => {
    const html = senderDetailsHtml(senderDetailsModel(spoof));
    expect(html).toContain('Sender Details');
    expect(html).toContain('>From<');
    expect(html).toContain('>Name<');
    expect(html).toContain('Authentication');
    for (const label of ['SPF', 'DKIM', 'DMARC']) expect(html).toContain(`>${label}<`);
    expect(html).toContain('mv-dot mv-ok"></span><span class="mv-k">DKIM'); // pass
    expect(html).toContain('mv-dot mv-bad"></span><span class="mv-k">SPF'); // softfail
    expect(html).toContain('mv-dot mv-bad"></span><span class="mv-k">DMARC'); // fail
    expect(html).toContain('mv-t-bad');
    expect(html).toContain('mv-t-warn');
    expect(html).toContain('Reply-To');
    expect(html).toContain('collect@elsewhere.example');
    expect(html).not.toContain('matches sender');
  });

  it('a matching Reply-To says so instead of the address', () => {
    const html = senderDetailsHtml(senderDetailsModel({ from: { address: 'a@x.example' }, replyTo: [{ address: 'b@x.example' }], authenticationResults: 'spf=pass' }));
    expect(html).toContain('matches sender');
    expect(html).not.toContain('b@x.example');
  });

  it('with neither results nor issues, says no authentication data is available', () => {
    const html = senderDetailsHtml(senderDetailsModel({ from: { address: 'a@x.example' } }));
    expect(html).toContain('No authentication data available');
    expect(html).not.toContain('Authentication</h3>');
  });

  it('escapes every value', () => {
    const html = senderDetailsHtml({
      address: '"><script>a()</script>', name: '<img src=x onerror=b()>',
      issues: [{ level: 'danger', text: '<b>x</b>' }], auth: { spf: '<i>', dkim: null, dmarc: null },
      replyTo: { address: '<u>r</u>', matches: false }, noData: false,
    });
    expect(html).not.toMatch(/<script|<img|<b>|<i>|<u>/);
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;img src=x onerror=b()&gt;');
  });
});
