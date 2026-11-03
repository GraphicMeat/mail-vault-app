// The bug email attaches the log tail on its own, so the sender never has to
// find, export and attach it. What makes that safe is that the text comes from
// `read_anonymous_logs` (addresses masked even in Verbose), never `read_logs`,
// and that a log which cannot be read costs the report nothing.

import { describe, it, expect, vi } from 'vitest';
import { anonymousLogsAttachment, ANONYMOUS_LOGS_FILENAME } from '../anonymousLogs';

const decode = (b64) => Buffer.from(b64, 'base64').toString('utf8');

describe('anonymousLogsAttachment', () => {
  it('attaches the anonymised log tail as a base64 text file named "anonymous logs"', async () => {
    const invoke = vi.fn(async () => 'INFO sync <gmail#ab12> ok\nINFO done ünï');
    const att = await anonymousLogsAttachment(invoke);

    expect(invoke).toHaveBeenCalledWith('read_anonymous_logs', { lines: 500 });
    expect(att.filename).toBe(ANONYMOUS_LOGS_FILENAME);
    expect(ANONYMOUS_LOGS_FILENAME).toBe('anonymous-logs.txt');
    expect(att.contentType).toBe('text/plain');
    expect(att.encoding).toBe('base64');
    expect(att.isFromOriginal).toBe(false);
    expect(decode(att.content)).toBe('INFO sync <gmail#ab12> ok\nINFO done ünï');
    expect(att.size).toBe(Buffer.from('INFO sync <gmail#ab12> ok\nINFO done ünï').length);
  });

  it('never asks for the raw log command', async () => {
    const invoke = vi.fn(async () => 'x');
    await anonymousLogsAttachment(invoke);
    expect(invoke).not.toHaveBeenCalledWith('read_logs', expect.anything());
  });

  it('attaches nothing when there is no native shell (browser / demo)', async () => {
    expect(await anonymousLogsAttachment(undefined)).toBeNull();
  });

  it('attaches nothing when the read fails, so the report still opens', async () => {
    const invoke = vi.fn(async () => { throw new Error('boom'); });
    expect(await anonymousLogsAttachment(invoke)).toBeNull();
  });

  it('attaches nothing for an empty log', async () => {
    expect(await anonymousLogsAttachment(async () => '')).toBeNull();
  });
});
