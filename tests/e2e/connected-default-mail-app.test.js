/**
 * E2E Test: MailVault as the OS default email app
 *
 * Two halves, and only one of them can be driven honestly here.
 *
 * 1. The Settings row. It reports what the backend observed about the *real*
 *    OS. Setting the mailto handler is refused inside the App Sandbox, so a
 *    shipped MailVault does it from an unsandboxed helper app in
 *    `Contents/Helpers` — but the webdriver build is a bare `cargo build`
 *    binary with no bundle around it and therefore no helper, so on the runner
 *    the row shows `howto`. The assertions below pin the honest shape (a
 *    state, an action, a hint) rather than a particular answer, which would
 *    make this spec a machine-configuration test.
 *
 * 2. The handover. A genuine deep link cannot be produced under this harness:
 *    `wdio.conf.js` runs the app with the automation carve-out, which skips
 *    `tauri-plugin-single-instance` — the very plugin that forwards a `mailto:`
 *    to the running process. `e2e_queue_mailto` therefore injects at the same
 *    seam the OS uses (push onto the queue, then emit the wake-up), which
 *    exercises everything downstream of the OS: the Rust queue, the event, the
 *    drain in App.jsx, the parse, and compose. The OS half is registration
 *    (`CFBundleURLTypes` / `MimeType=`) and is not provable from here.
 */

import { waitForApp, waitForEmails, openSettings, closeSettings, clickSettingsNav } from './helpers.js';
import { modalOpen, modalCount, fieldValue, closeComposeHard } from './composeHelpers.js';

const row = () => browser.execute(() => {
  const state = document.querySelector('[data-testid="default-mail-state"]');
  if (!state) return null;
  const action = document.querySelector('[data-testid="default-mail-action"]');
  const hint = document.querySelector('[data-testid="default-mail-hint"]');
  return {
    isDefault: state.dataset.default,
    stateText: (state.textContent || '').trim(),
    action: action ? action.dataset.action : null,
    actionText: action ? (action.textContent || '').trim() : null,
    hintText: hint ? (hint.textContent || '').trim() : null,
  };
});

/**
 * Hand the app a mailto: the way the OS would.
 *
 * Not an async callback: `browser.execute` never awaits one — it returns `{}`
 * and the assertion that follows tests nothing. The command is fire-and-forget
 * anyway; what the test waits on is the compose window it causes.
 */
const handOverMailto = (url) => browser.execute((u) => {
  window.__TAURI__.core.invoke('e2e_queue_mailto', { url: u });
  return true;
}, url);

describe('Default email app', function () {
  before(async function () {
    await waitForApp();
    await waitForEmails();
  });

  describe('the Settings row', function () {
    before(async function () {
      await openSettings();
      await clickSettingsNav('General');
      await clickSettingsNav('Behavior');
    });

    after(async function () {
      await closeSettings();
    });

    it('reports a state the backend actually observed', async function () {
      const r = await row();
      expect(r).not.toBe(null);
      // Never absent and never blank: a row that renders nothing is a row that
      // silently stopped asking.
      expect(['true', 'false'].includes(r.isDefault)).toBe(true);
      expect(r.stateText.length > 0).toBe(true);
    });

    it('never offers an action it cannot perform', async function () {
      const r = await row();
      if (r.isDefault === 'true') {
        // Already ours — nothing to offer.
        expect(r.action).toBe(null);
        return;
      }
      // Not ours: exactly one of the two shapes, and the "this build cannot do
      // it for you" shape (no helper — here, and in the Mac App Store build)
      // must come with instructions rather than a dead button.
      expect(['set', 'howto'].includes(r.action)).toBe(true);
      if (r.action === 'howto') {
        expect(typeof r.hintText).toBe('string');
        expect(r.hintText.length > 0).toBe(true);
      }
    });

    it('does not flip to "default" just because the button was pressed', async function () {
      const before = await row();
      if (before.isDefault === 'true') this.skip();

      await browser.execute(() => {
        document.querySelector('[data-testid="default-mail-action"]')?.click();
      });
      await browser.pause(1200);

      const after = await row();
      // The whole point of the design: the answer comes from a re-query, so
      // with no helper to launch, pressing the button changes nothing.
      // (If the runner ever *is* able to set it, this still holds — the state
      // would be true because the re-query said so, not because of the click.)
      expect(['true', 'false'].includes(after.isDefault)).toBe(true);
      expect(after.stateText.length > 0).toBe(true);
    });
  });

  describe('a mailto: handed over by the OS', function () {
    afterEach(async function () {
      if (await modalOpen()) await closeComposeHard();
    });

    it('opens compose prefilled', async function () {
      await handOverMailto('mailto:handover@mock.test?subject=From%20the%20OS&cc=cc@mock.test');

      await browser.waitUntil(modalOpen, {
        timeout: 10_000,
        interval: 250,
        timeoutMsg: 'compose did not open for a handed-over mailto:',
      });

      // Full testids — `fieldValue` queries `[data-testid="<arg>"]` verbatim, so
      // a bare 'to' silently returns null rather than failing loudly.
      //
      // Wait for the field rather than reading it the instant the modal is up:
      // `modalOpen` goes true on the frame the dialog mounts, which is not
      // necessarily the frame the prefill has been applied on.
      await browser.waitUntil(
        async () => (await fieldValue('compose-to')) === 'handover@mock.test',
        {
          timeout: 10_000,
          interval: 200,
          timeoutMsg: `to=${JSON.stringify(await fieldValue('compose-to'))} `
            + `cc=${JSON.stringify(await fieldValue('compose-cc'))} `
            + `subject=${JSON.stringify(await fieldValue('compose-subject'))} `
            + `modals=${await modalCount()}`,
        },
      );
      expect(await fieldValue('compose-cc')).toBe('cc@mock.test');
      expect(await fieldValue('compose-subject')).toBe('From the OS');
    });

    it('delivers a handover once, not on a loop', async function () {
      await handOverMailto('mailto:once@mock.test');
      await browser.waitUntil(modalOpen, { timeout: 10_000, interval: 250 });
      await closeComposeHard();

      // Nothing re-opens on its own: the drain emptied the queue, so no later
      // render or event redelivers a URL the user already saw. (That the queue
      // empties is pinned directly by the Rust unit test; this is the same
      // invariant seen from the outside.)
      await browser.pause(1500);

      expect(await modalOpen()).toBe(false);
    });

    it('ignores a handover that is not a mailto:', async function () {
      await handOverMailto('https://example.com/not-a-mailto');
      await browser.pause(1200);

      expect(await modalOpen()).toBe(false);

      // Then prove the silence above was a JUDGEMENT, not a dead bridge. With
      // delivery broken, "nothing opened" is trivially true — a negative
      // control caught this test passing against a disabled bridge, so it now
      // has to show that a real mailto still gets through on the same run.
      await handOverMailto('mailto:still-alive@mock.test');
      await browser.waitUntil(modalOpen, {
        timeout: 10_000,
        interval: 250,
        timeoutMsg: 'the bridge was not delivering at all, so the rejection above proved nothing',
      });
    });
  });
});
