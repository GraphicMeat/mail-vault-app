import { describe, expect, it } from 'vitest';
import { LAUNCH_END, LAUNCH_START, NEW_USER_DELAY_MS, launchLive, nextLaunchBoundary } from '../productHuntLaunch';

describe('Product Hunt launch window', () => {
  it('opens at 12:01 am PT, which is 10:01 am EEST, and lasts 24 hours', () => {
    expect(LAUNCH_START).toBe(Date.parse('2026-10-04T00:01:00-07:00'));
    expect(LAUNCH_START).toBe(Date.parse('2026-10-04T10:01:00+03:00'));
    expect(LAUNCH_END - LAUNCH_START).toBe(24 * 60 * 60 * 1000);
  });

  it('is live for the whole window and nowhere else', () => {
    expect(launchLive(LAUNCH_START - 1)).toBe(false);
    expect(launchLive(LAUNCH_START)).toBe(true);
    expect(launchLive(LAUNCH_END - 1)).toBe(true);
    expect(launchLive(LAUNCH_END)).toBe(false);
  });

  it('names the next flip, then none once the window is over', () => {
    expect(nextLaunchBoundary(LAUNCH_START - 5)).toBe(LAUNCH_START);
    expect(nextLaunchBoundary(LAUNCH_START + 5)).toBe(LAUNCH_END);
    expect(nextLaunchBoundary(LAUNCH_END)).toBeNull();
  });

  it('holds a new user back for 10 minutes after onboarding, never past the end', () => {
    const done = LAUNCH_START + 60_000;
    expect(launchLive(done + NEW_USER_DELAY_MS - 1, done)).toBe(false);
    expect(launchLive(done + NEW_USER_DELAY_MS, done)).toBe(true);
    expect(nextLaunchBoundary(done, done)).toBe(done + NEW_USER_DELAY_MS);
    expect(nextLaunchBoundary(done + NEW_USER_DELAY_MS, done)).toBe(LAUNCH_END);
    // Onboarded before the window opened: the window's start still rules.
    expect(launchLive(LAUNCH_START, LAUNCH_START - 3600_000)).toBe(true);
    // Onboarded so late the 10 minutes run past the end: never shown.
    expect(launchLive(LAUNCH_END - 1, LAUNCH_END - 60_000)).toBe(false);
    expect(nextLaunchBoundary(LAUNCH_END - 60_000, LAUNCH_END - 60_000)).toBeNull();
  });
});
