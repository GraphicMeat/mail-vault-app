export const ANONYMOUS_LOGS_FILENAME = 'anonymous-logs.txt';

// btoa over one huge String.fromCharCode spread overflows the argument limit.
function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { content: btoa(bin), size: bytes.length };
}

/**
 * The log tail for a bug email, as a compose attachment. Reads
 * `read_anonymous_logs` (addresses masked even in Verbose), never the raw
 * `read_logs`. Null when there is nothing to attach: a log that cannot be
 * read must never stop the report from opening.
 */
export async function anonymousLogsAttachment(invoke) {
  if (!invoke) return null;
  try {
    const text = await invoke('read_anonymous_logs', { lines: 500 });
    if (!text) return null;
    return {
      filename: ANONYMOUS_LOGS_FILENAME,
      contentType: 'text/plain',
      encoding: 'base64',
      isFromOriginal: false,
      ...toBase64(text),
    };
  } catch (error) {
    console.warn('[bug report] could not read anonymous logs:', error);
    return null;
  }
}
