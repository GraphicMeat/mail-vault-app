// Own module so a test that mocks replyTarget still gets the real guard.

/**
 * The message with the index snippet a reader shows while its body downloads
 * (`_bodyLoading`, selectEmail) taken off: that text is the first line or so,
 * not the message, and quoting or forwarding it would send a truncated body.
 */
export function withoutSnippet(email) {
  if (!email?._bodyLoading) return email;
  const { _bodyLoading, text, ...rest } = email;
  return rest;
}
