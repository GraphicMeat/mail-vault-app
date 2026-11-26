// Compose's follow-up reminder choices ("Remind me if no reply"): Off, 1 day, 3 days, 1 week.

/** The choices: days, and the label's key. Literal keys for the catalog tests. */
export const REMIND_CHOICES = Object.freeze([
  [0, 'compose.remind.off'],
  [1, 'compose.remind.days1'],
  [3, 'compose.remind.days3'],
  [7, 'compose.remind.days7'],
]);

/** The key of the duration's words ("3 days") for the chip, or null for a count that is no choice. */
export function remindDurationKey(days) {
  return REMIND_CHOICES.find(([d]) => d > 0 && d === days)?.[1] ?? null;
}
