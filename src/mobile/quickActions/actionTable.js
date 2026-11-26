// What the phone does with each of desktop's quick actions on the list row's wheel and the
// selection bar. Every action desktop has gets a decision here and a test holds it to that
// (quickActionsDescriptors.test.js), so none is ever silently missing from a wheel the person
// imported or built:
//
//   run      the phone runs it (the action's handler, descriptors.js)
//   desktop  the phone cannot: the wedge is there, disabled, and its name says "on desktop"
//   hidden   desktop itself shows it only for some messages and the phone has no such message
//            (no List-Unsubscribe header on a row, no message seen out of place): hidden as
//            desktop hides it there
//   reader   the reader's tools, never on a row or the selection bar
//
// Row and selection share the table; what a surface cannot do at all (Reply over a selection)
// is desktop's own rule (quickActionAvailability.js) and shows as disabled without the suffix.
export const DECISIONS = Object.freeze({
  archive: { decision: 'desktop', why: 'Archive copies mail into the vault, which lives on the desktop; the phone keeps a window of recent mail instead.' },
  unarchive: { decision: 'desktop', why: 'Unarchive removes the vault copy; the phone has no vault.' },
  delete: { decision: 'run' },
  deleteServer: { decision: 'run' },
  deleteEverywhere: { decision: 'desktop', why: 'Delete everywhere purges server, vault and backup copies; the phone holds only the server copy.' },
  toggleRead: { decision: 'run' },
  markRead: { decision: 'run' },
  markUnread: { decision: 'run' },
  star: { decision: 'run' },
  unstar: { decision: 'run' },
  tag: { decision: 'run' },
  move: { decision: 'run' },
  spam: { decision: 'run' },
  reply: { decision: 'run' },
  replyAll: { decision: 'run' },
  forward: { decision: 'run' },
  replyTemplate: { decision: 'desktop', why: 'A reply template is named by a desktop id the phone\'s templates do not carry; the phone inserts templates from compose.' },
  export: { decision: 'desktop', why: 'Exporting a message as an image or file is a desktop tool.' },
  newMessage: { decision: 'desktop', why: 'New message to the sender: the phone starts a message from its compose button.' },
  open: { decision: 'desktop', why: 'Open in a new window: the phone has one screen.' },
  source: { decision: 'reader', why: 'The reader\'s Source tool, never on a row.' },
  theme: { decision: 'reader', why: 'The reader\'s light or dark toggle, never on a row.' },
  snooze: { decision: 'desktop', why: 'Snooze brings a message back later through the desktop\'s scheduler.' },
  unsubscribe: { decision: 'hidden', why: 'Shown on desktop only for a message with a List-Unsubscribe header; the phone\'s list rows do not carry one.' },
  goToMailbox: { decision: 'hidden', why: 'Shown on desktop only for a message seen out of place (a search hit); the phone\'s rows are always in their folder.' },
});

/** `run`, `desktop`, `hidden` or `reader`: an action desktop does not have is `desktop`. */
export const decisionOf = (action) => DECISIONS[action]?.decision || 'desktop';
