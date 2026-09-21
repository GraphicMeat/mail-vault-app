// What a scheduled send's copy says about whether MailVault has to be
// running — kept as one pure function so the picker and the folder never
// drift into saying different things, and so the branch is testable without
// mounting a component.
//
// `daemonAlwaysOn` is the ONLY thing this keys off. It is real settings state
// Rust reads back from the OS (see DaemonAlwaysOn.jsx) — never true unless the
// OS actually confirmed the login item, and never true at all on a build that
// cannot offer it (Mac App Store). So "sends in the background" is never said
// on a build where that is not promised, without this file needing to know
// which build it is on.
export function scheduledSendCopyKey(daemonAlwaysOn) {
  return daemonAlwaysOn ? 'scheduled.copy.background' : 'scheduled.copy.nextLaunch';
}

/** Whether to additionally offer turning always-on on, from `autostart_state`. */
export function canOfferAlwaysOn(daemonAlwaysOn, autostart) {
  return !daemonAlwaysOn && !!autostart?.supported;
}
