// Run with `node --test scripts/screenshots/contactsSeed.check.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { studioScenario, personalScenario } from './demoData.js';
import { withContactsCc } from './contactsSeed.js';

const inboxOf = (scenario) => scenario.state.mailboxes.find((m) => m.name === 'INBOX').messages;

test("adds To and Cc to Theo's press slot message only", () => {
  const before = studioScenario();
  const after = withContactsCc(before);
  const changed = inboxOf(after).filter((m, i) => m.raw !== inboxOf(before)[i].raw);
  assert.equal(changed.length, 1);
  assert.match(changed[0].raw, /^To: Rowan Marsh <rowan@primecut.studio>, Dario Vella <dario@rackandrind.com>$/m);
  assert.match(changed[0].raw, /^Cc: Ana Brandt <ana@sizzlemedia.co>, Nell Okafor <nell@smokehouse.design>$/m);
  assert.match(changed[0].raw, /^From: Theo Lomas <theo@skewer.systems>$/m);
  assert.match(changed[0].raw, /^Subject: Press slot Friday 06:00/m);
  assert.equal(inboxOf(after).length, inboxOf(before).length);
  for (const mailbox of after.state.mailboxes.filter((m) => m.name !== 'INBOX')) {
    assert.deepEqual(mailbox, before.state.mailboxes.find((m) => m.name === mailbox.name));
  }
});

test('does not mutate the input scenario', () => {
  const input = studioScenario();
  const snapshot = structuredClone(input);
  withContactsCc(input);
  assert.deepEqual(input, snapshot);
});

test('names the missing message and the inbox size', () => {
  const scenario = personalScenario();
  assert.throws(
    () => withContactsCc(scenario),
    (e) => e.message.includes('theo@skewer.systems') && e.message.includes(`in ${inboxOf(scenario).length} INBOX messages`),
  );
});
