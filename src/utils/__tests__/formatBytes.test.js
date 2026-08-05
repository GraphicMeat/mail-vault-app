import { describe, it, expect } from 'vitest';
import { formatBytes } from '../formatBytes';

describe('formatBytes', () => {
  it('returns "--" for null/undefined/NaN', () => {
    expect(formatBytes(null)).toBe('--');
    expect(formatBytes(undefined)).toBe('--');
    expect(formatBytes(NaN)).toBe('--');
  });

  it('formats bytes under 1024 as B', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
  });

  it('formats KB with 1 decimal', () => {
    expect(formatBytes(1536)).toBe('1.5 KB');
  });

  it('formats MB with 1 decimal', () => {
    expect(formatBytes(1572864)).toBe('1.5 MB');
  });

  it('formats GB with 1 decimal', () => {
    expect(formatBytes(1610612736)).toBe('1.5 GB');
  });
});
