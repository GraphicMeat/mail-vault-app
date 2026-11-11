import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// The phone set-up reads accounts with secrets through getAccounts, so like
// Export it opens in the MAIN window only: Settings (docked or detached) hands
// the action up, App.jsx renders the modal. Rendering App here is not
// practical, so these read the wiring off the sources.
const src = file => readFileSync(resolve(process.cwd(), file), 'utf8');

it('App.jsx renders PhoneQrModal in the main window, lazily, beside ExportModal', () => {
  const app = src('src/App.jsx');
  expect(app).toMatch(/lazy\(\(\) => import\('\.\/components\/transfer\/PhoneQrModal'\)/);
  expect(app).toMatch(/\{showPhoneQrModal && <PhoneQrModal onClose=\{\(\) => setShowPhoneQrModal\(false\)\} \/>\}/);
  // docked Settings closes itself and opens the modal
  expect(app).toMatch(/onSetupPhone=\{\(\) => \{ closeSettings\(\); setShowPhoneQrModal\(true\); \}\}/);
  // a detached Settings window hands the action over
  expect(app).toMatch(/event\.payload\.action === 'setup-phone'\) setShowPhoneQrModal\(true\)/);
  // no onboarding invitation on top of it
  expect(app).toMatch(/onboardingPromptReady = [^;]*!showPhoneQrModal/);
});

it('the detached Settings window hands the phone set-up to the main window', () => {
  expect(src('src/components/SettingsWindow.jsx')).toMatch(/onSetupPhone=\{\(\) => handoff\('setup-phone'\)\}/);
});

it('Settings passes onSetupPhone down to the accounts section', () => {
  expect(src('src/components/SettingsPage.jsx')).toMatch(/onSetupPhone=\{onSetupPhone\}/);
  expect(src('src/components/settings/AccountSettings.jsx')).toMatch(/<AccountTransfer [^>]*onSetupPhone=\{onSetupPhone\}/);
});
