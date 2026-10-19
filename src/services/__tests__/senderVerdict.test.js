import { describe, it, expect, beforeEach, vi } from 'vitest';

// The daemon decides the verdict (message.verify_sender). When it cannot be
// asked, the answer is "not checked", never "nothing to flag": a clean shield
// would hide the dkim=fail or spoof warning the app used to show in-process.
const daemonCall = vi.fn();
vi.mock('../daemonClient', () => ({ daemonCall: (...a) => daemonCall(...a) }));

const { verifySender, cachedVerdict, verdictKey, verdictTooltip, _resetSenderVerdicts, UNAVAILABLE } = await import('../senderVerdict');

const email = { from: { name: 'Prize Desk', address: 'win@prize.example' }, authenticationResults: 'mx; dkim=fail' };
const danger = { status: 'danger', tooltip: [], issues: [], auth: { spf: null, dkim: 'fail', dmarc: null }, dkim: null };

beforeEach(() => {
  _resetSenderVerdicts();
  daemonCall.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('verifySender when the daemon cannot be asked', () => {
  it('answers "unavailable", worded as not checked, never the clean "none"', async () => {
    daemonCall.mockRejectedValue(new Error('daemon unavailable'));
    const v = await verifySender(email);
    expect(v.status).toBe('unavailable');
    expect(v).toBe(UNAVAILABLE);
    expect(verdictTooltip(v, (key) => key)).toBe('util.senderCheck.senderNotChecked');
  });

  it('keeps no "unavailable" answer: the next look asks again and gets the real verdict', async () => {
    daemonCall.mockRejectedValueOnce(new Error('daemon unavailable'));
    expect((await verifySender(email)).status).toBe('unavailable');
    expect(cachedVerdict(verdictKey(email))).toBeUndefined();
    daemonCall.mockResolvedValueOnce(danger);
    expect((await verifySender(email)).status).toBe('danger');
    expect(daemonCall).toHaveBeenCalledTimes(2);
    expect(cachedVerdict(verdictKey(email))).toEqual(danger);
  });
});
