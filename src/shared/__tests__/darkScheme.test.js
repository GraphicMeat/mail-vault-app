import { describe, it, expect } from 'vitest';
import { suppressDarkScheme } from '../darkScheme';

describe('darkScheme', () => {
  it('renames the dark query feature, keeping spacing and other queries', () => {
    expect(suppressDarkScheme('@media (prefers-color-scheme : dark){a{}}')).toBe('@media (mv-suppressed-color-scheme : dark){a{}}');
    expect(suppressDarkScheme('(PREFERS-COLOR-SCHEME:dark) and (prefers-color-scheme:light)')).toBe('(mv-suppressed-color-scheme:dark) and (prefers-color-scheme:light)');
  });
});
