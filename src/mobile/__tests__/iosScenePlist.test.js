// @vitest-environment node
// iOS 27 on a device terminates an app that has not adopted the UIScene lifecycle
// (UIKit `_UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption`, SIGTRAP at launch).
// tao only installs its scene delegate when Info.plist declares a scene manifest with
// UIApplicationSupportsMultipleScenes = true. Tauri merges src-tauri-mobile/Info.ios.plist into
// the generated Info.plist at build time, so the key lives there and survives `tauri ios init`.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const plistPath = resolve(__dirname, '../../../src-tauri-mobile/Info.ios.plist');
const genPlistPath = resolve(__dirname, '../../../src-tauri-mobile/gen/apple/mailvault-mobile_iOS/Info.plist');

/** The strings of the `<array>` under `key`, in order (empty when the key is missing). */
function arrayFor(xml, key) {
  const m = xml.replace(/\s+/g, '').match(new RegExp(`<key>${key}</key><array>(.*?)</array>`));
  return m ? [...m[1].matchAll(/<string>([^<]*)<\/string>/g)].map((x) => x[1]) : [];
}

describe('iOS Info.ios.plist', () => {
  it('declares a scene manifest that turns on tao scene lifecycle', () => {
    const xml = readFileSync(plistPath, 'utf8');
    const compact = xml.replace(/\s+/g, '');
    expect(compact).toContain(
      '<key>UIApplicationSceneManifest</key><dict><key>UIApplicationSupportsMultipleScenes</key><true/>',
    );
  });

  // Background work (plan Ruling 9): iOS runs a BGAppRefreshTask only for an app that declares
  // the `fetch` mode, and a BGProcessingTask (the longer catch-up download) only with the
  // `processing` mode; each task's identifier must be permitted. Background.swift registers both.
  // Tauri merges this file into the generated Info.plist, which is checked in too: both must say
  // the same, or a build from the checked-in project lacks what `tauri ios build` would add.
  for (const [name, path] of [
    ['Info.ios.plist', plistPath],
    ['gen/apple Info.plist', genPlistPath],
  ]) {
    it(`${name} permits the background refresh and processing tasks`, () => {
      const xml = readFileSync(path, 'utf8');
      expect(arrayFor(xml, 'UIBackgroundModes').sort()).toEqual(['fetch', 'processing']);
      expect(arrayFor(xml, 'BGTaskSchedulerPermittedIdentifiers').sort()).toEqual([
        'com.mailvault.app.refresh',
        'com.mailvault.app.sync',
      ]);
    });
  }

  // The barcode scanner refuses to start without it, and iOS kills an app that opens the camera
  // with no usage string.
  it('says why it asks for the camera', () => {
    const compact = readFileSync(plistPath, 'utf8').replace(/\s+/g, ' ');
    const m = compact.match(/<key>NSCameraUsageDescription<\/key> <string>([^<]+)<\/string>/);
    expect(m, 'NSCameraUsageDescription').not.toBeNull();
    expect(m[1]).toMatch(/code/i);
  });
});
