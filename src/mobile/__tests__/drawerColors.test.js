// @vitest-environment node
// The colour of a folder glyph on the phone is desktop's (src/utils/folderIconColor.js) over the
// phone's `folderIconStyle` and `folderIconColors` preferences: one function for the drawer, the
// move picker and every other place the phone draws a folder.
import { describe, it, expect } from 'vitest';
import { phoneFolderColor } from '../drawer/folderColor.js';
import { PREF_DEFAULTS } from '../prefs.js';

const f = (path, specialUse = null) => ({ path, name: path, specialUse });

describe('phoneFolderColor', () => {
  it('colours a folder by its role, whatever case the server spells the special use in', () => {
    expect(phoneFolderColor(f('INBOX', '\\Inbox'), 'a1', PREF_DEFAULTS)).toBe('#3b82f6');
    expect(phoneFolderColor(f('INBOX'), 'a1', PREF_DEFAULTS)).toBe('#3b82f6');
    expect(phoneFolderColor(f('Sent', '\\sent'), 'a1', PREF_DEFAULTS)).toBe('#0ea5e9');
    expect(phoneFolderColor(f('Drafts', '\\DRAFTS'), 'a1', PREF_DEFAULTS)).toBe('#d946ef');
    expect(phoneFolderColor(f('Bin', '\\trash'), 'a1', PREF_DEFAULTS)).toBe('#ef4444');
    expect(phoneFolderColor(f('Spam', '\\Junk'), 'a1', PREF_DEFAULTS)).toBe('#f59e0b');
    expect(phoneFolderColor(f('Old', '\\Archive'), 'a1', PREF_DEFAULTS)).toBe('#8b5cf6');
    expect(phoneFolderColor(f('Projects'), 'a1', PREF_DEFAULTS)).toBe('#14b8a6');
  });

  it('the theme style gives every folder the one accent', () => {
    const prefs = { ...PREF_DEFAULTS, folderIconStyle: 'theme' };
    expect(phoneFolderColor(f('INBOX'), 'a1', prefs)).toBe('var(--mail-accent-text)');
    expect(phoneFolderColor(f('Projects'), 'a1', prefs)).toBe('var(--mail-accent-text)');
  });

  it('a colour picked for one folder of one account beats both, and bad picks are ignored', () => {
    const prefs = { ...PREF_DEFAULTS, folderIconStyle: 'theme', folderIconColors: { 'a1|Projects': '#A855F7', 'a1|Sent': 'red', 'a2|Projects': '#22c55e' } };
    expect(phoneFolderColor(f('Projects'), 'a1', prefs)).toBe('#a855f7');
    expect(phoneFolderColor(f('Projects'), 'a2', prefs)).toBe('#22c55e');
    expect(phoneFolderColor(f('Projects'), 'a3', prefs)).toBe('var(--mail-accent-text)');
    expect(phoneFolderColor(f('Sent', '\\Sent'), 'a1', prefs)).toBe('var(--mail-accent-text)');
  });

  it('an unknown style or a missing preference reads as the default look', () => {
    expect(phoneFolderColor(f('INBOX'), 'a1', { folderIconStyle: 'neon' })).toBe('#3b82f6');
    expect(phoneFolderColor(f('INBOX'), 'a1', undefined)).toBe('#3b82f6');
  });
});

describe('the phone preferences', () => {
  it('start as desktop does: colourful, no picks', () => {
    expect(PREF_DEFAULTS.folderIconStyle).toBe('colorful');
    expect(PREF_DEFAULTS.folderIconColors).toEqual({});
  });
});
