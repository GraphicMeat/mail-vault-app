import { buildExport } from './exportService';
import { ensurePrivacyDictionary } from '../../utils/privacy/privacyDictionary';

/**
 * Builds an export where the messages live. Callers ask in plain data
 * (`redact: { style }` or null) and the dictionary is fetched here, so the same
 * request can cross to the main window from an export window of its own.
 */
export async function buildLocal({ redact, ...rest }) {
  // Not captureMask: that would mask the live UI too. The host builds the
  // dictionary while the export waits for it.
  const redactOpts = redact ? { style: redact.style, dict: await ensurePrivacyDictionary() } : null;
  return buildExport({ ...rest, redact: redactOpts });
}
