import { describe, it, expect } from 'vitest';
import { scheduledSendCopyKey, canOfferAlwaysOn } from '../scheduledCopy';

describe('scheduledSendCopyKey', () => {
  it('says "next launch" when always-on is off', () => {
    expect(scheduledSendCopyKey(false)).toBe('scheduled.copy.nextLaunch');
  });

  it('says "background" when always-on is confirmed on', () => {
    expect(scheduledSendCopyKey(true)).toBe('scheduled.copy.background');
  });
});

describe('canOfferAlwaysOn', () => {
  it('offers turning it on when off and the OS says it is supported', () => {
    expect(canOfferAlwaysOn(false, { supported: true })).toBe(true);
  });

  it('never offers it once already on', () => {
    expect(canOfferAlwaysOn(true, { supported: true })).toBe(false);
  });

  it('never offers it where the OS says it is unsupported', () => {
    expect(canOfferAlwaysOn(false, { supported: false })).toBe(false);
  });

  it('never offers it before autostart_state has answered', () => {
    expect(canOfferAlwaysOn(false, null)).toBe(false);
  });
});
