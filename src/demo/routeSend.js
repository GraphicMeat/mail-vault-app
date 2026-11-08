// Demo-only copy of core's `compose_prep::route_send` (src-core/src/compose_prep.rs):
// the browser demo has no daemon, so its `compose.check` routes here. The app
// asks the daemon. Parity with core is pinned by the shared fixture
// (src-core/tests/fixtures/compose-prep-cases.json) in composePrepIsolation.test.js.
//
// A plan is null (send now, the global send delay applies), `{ kind: 'in',
// minutes }` or `{ kind: 'at' }` (the picked `scheduleDraft`). A delay that
// fits the undo window goes through the in-memory undo-send queue; anything
// longer is a scheduled send.

import { FREE_DELAY_MINUTES } from '../utils/sendPlan';
import { wallClockAt } from '../utils/scheduledTime';

/**
 * `{ delay }` (seconds; null = the global delay) for the undo-send queue, or
 * `{ draft }` ({ localTime, tz }) for a scheduled send. A relative plan's
 * wall clock is taken at Send, in the given zone, not when it was armed.
 */
export function routeSend(plan, scheduleDraft, now = Date.now(), tz = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  if (plan?.kind === 'at') return { draft: scheduleDraft };
  if (plan?.kind !== 'in' || !(plan.minutes > 0)) return { delay: null };
  if (plan.minutes <= FREE_DELAY_MINUTES) return { delay: plan.minutes * 60 };
  // Rounded up to the next whole minute: a truncated wall clock could land
  // under the delay the user asked for.
  return { draft: { localTime: wallClockAt(now + plan.minutes * 60_000 + 59_999, tz), tz } };
}
