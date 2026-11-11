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

describe('iOS Info.ios.plist', () => {
  it('declares a scene manifest that turns on tao scene lifecycle', () => {
    const xml = readFileSync(plistPath, 'utf8');
    const compact = xml.replace(/\s+/g, '');
    expect(compact).toContain(
      '<key>UIApplicationSceneManifest</key><dict><key>UIApplicationSupportsMultipleScenes</key><true/>',
    );
  });

  // Background fetch (plan Ruling 9): iOS runs a BGAppRefreshTask only for an app that declares
  // the `fetch` mode and permits the task's identifier; the shell's Background.swift registers it.
  it('permits the background refresh task', () => {
    const compact = readFileSync(plistPath, 'utf8').replace(/\s+/g, '');
    expect(compact).toContain('<key>UIBackgroundModes</key><array><string>fetch</string></array>');
    expect(compact).toContain(
      '<key>BGTaskSchedulerPermittedIdentifiers</key><array><string>com.mailvault.app.refresh</string></array>',
    );
  });

  // The barcode scanner refuses to start without it, and iOS kills an app that opens the camera
  // with no usage string.
  it('says why it asks for the camera', () => {
    const compact = readFileSync(plistPath, 'utf8').replace(/\s+/g, ' ');
    const m = compact.match(/<key>NSCameraUsageDescription<\/key> <string>([^<]+)<\/string>/);
    expect(m, 'NSCameraUsageDescription').not.toBeNull();
    expect(m[1]).toMatch(/code/i);
  });
});
