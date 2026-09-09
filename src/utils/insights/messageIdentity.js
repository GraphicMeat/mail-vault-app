const text = value => typeof value === 'string' ? value.trim() : '';
const instant = value => {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : '';
};

function originalDate(message) {
  if (Object.prototype.hasOwnProperty.call(message || {}, 'messageDate')) return instant(message.messageDate);
  // Graph's legacy date means arrival, so it cannot prove an RFC Date conflict.
  if (message?.provider === 'graph' || message?.source === 'graph' || message?._graphId) return '';
  return instant(message?.date);
}

/** Reject contradictory header identity at a verified physical message locator. */
export function insightsBodyMatchesHeader(header, body) {
  if (!header || !body) return false;
  const fields = message => [
    text(message.messageId || message.message_id),
    text(message.from?.address).toLowerCase(),
    originalDate(message),
    text(message.subject),
  ];
  const expected = fields(header), actual = fields(body);
  return expected.every((value, index) => !value || !actual[index] || value === actual[index]);
}
