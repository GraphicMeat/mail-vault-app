/**
 * Mock data the Contacts shots need on top of the demo mailbox: Theo's newest
 * standalone message gains recipients, so the "This email" tab has a To and a
 * Cc group to show. Pure: returns a copy, never touches the demoData output.
 */

const FROM = 'From: Theo Lomas <theo@skewer.systems>';
const SUBJECT = /^Subject: Press slot Friday 06:00/m;
const TO = 'To: Rowan Marsh <rowan@primecut.studio>, Dario Vella <dario@rackandrind.com>';
const CC = 'Cc: Ana Brandt <ana@sizzlemedia.co>, Nell Okafor <nell@smokehouse.design>';

const isPressSlot = (message) => message.raw.includes(FROM) && SUBJECT.test(message.raw);

function withRecipients(message) {
  const raw = message.raw.replace(/^To: .*$/m, `${TO}\n${CC}`);
  return { ...message, raw };
}

/** @param {{state: {mailboxes: {name: string, messages: {raw: string}[]}[]}}} scenario */
export function withContactsCc(scenario) {
  const inbox = scenario.state.mailboxes.find((mailbox) => mailbox.name === 'INBOX');
  if (!inbox?.messages.some(isPressSlot)) {
    throw new Error(`contacts seed: no INBOX message from theo@skewer.systems with subject "Press slot Friday 06:00" in ${inbox?.messages.length ?? 0} INBOX messages`);
  }
  const mailboxes = scenario.state.mailboxes.map((mailbox) => (mailbox === inbox
    ? { ...mailbox, messages: mailbox.messages.map((m) => (isPressSlot(m) ? withRecipients(m) : m)) }
    : mailbox));
  return { ...scenario, state: { ...scenario.state, mailboxes } };
}
