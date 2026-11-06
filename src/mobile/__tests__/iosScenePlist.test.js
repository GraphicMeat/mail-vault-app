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
});
