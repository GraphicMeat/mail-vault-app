// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MIME_TABLE, OCTET_STREAM, extForMime, mimeFromName } from '../mimeTypes';

describe('mimeTypes', () => {
  it('agrees row for row with the Rust core table', () => {
    const rs = readFileSync(fileURLToPath(new URL('../../../src-core/src/mime_types.rs', import.meta.url)), 'utf8');
    const body = rs.split('const TABLE')[1].split('];')[0];
    const rust = [...body.matchAll(/\("([^"]+)",\s*"([^"]+)"\)/g)].map((m) => [m[1], m[2]]);
    expect(rust.length).toBeGreaterThan(20);
    expect(MIME_TABLE).toEqual(rust);
  });
  it('maps names case-insensitively, falling back to octet-stream', () => {
    expect(mimeFromName('Photo.JPG')).toBe('image/jpeg');
    expect(mimeFromName('a.tar.zip')).toBe('application/zip');
    expect(mimeFromName('noext')).toBe(OCTET_STREAM);
    expect(mimeFromName('.png')).toBe(OCTET_STREAM);
    expect(mimeFromName(null)).toBe(OCTET_STREAM);
  });
  it('gives the canonical extension for a type', () => {
    expect(extForMime('image/jpeg; charset=x')).toBe('jpg');
    expect(extForMime('text/html')).toBe('html');
    expect(extForMime('x/y')).toBeNull();
  });
});
