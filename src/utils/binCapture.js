import { t } from '../i18n/index.js';

// The daemon refuses a permanent (or local-only) delete it could not keep a
// deleted-mail bin copy of first, as `E_BIN_CAPTURE:<reason>: <detail>` with
// `<reason>` one of fetch|timeout|busy|write. The detail is for the logs; the
// user reads catalog copy. A refusal with no reason (`E_BIN_CAPTURE: <detail>`,
// still sent by a local-folder delete) or a reason this app does not know reads
// as the generic sentence.
const PREFIX = 'E_BIN_CAPTURE:';
const REASON = /^E_BIN_CAPTURE:([a-z]+):/;

function copyFor(reason) {
  switch (reason) {
    case 'fetch': return t('errors.E_BIN_CAPTURE_FETCH');
    case 'timeout': return t('errors.E_BIN_CAPTURE_TIMEOUT');
    case 'busy': return t('errors.E_BIN_CAPTURE_BUSY');
    case 'write': return t('errors.E_BIN_CAPTURE_WRITE');
    default: return null;
  }
}

export function binCaptureError(error) {
  const message = typeof error === 'string' ? error : error?.message;
  if (typeof message !== 'string' || !message.startsWith(PREFIX)) return error;
  console.warn('[delete] refused, no copy could be kept first:', message);
  const reason = message.match(REASON)?.[1];
  const copy = copyFor(reason);
  if (copy === null) return new Error(t('errors.E_BIN_CAPTURE'));
  const out = new Error(copy);
  out.reason = reason;
  return out;
}
