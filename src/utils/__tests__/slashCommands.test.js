import { describe, expect, it } from 'vitest';
import en from '../../i18n/locales/en.json';
import { slashItems, SLASH_COMMANDS } from '../slashCommands';

const label = key => en[key];
const ids = items => items.map(item => item.id);

describe('slashItems', () => {
  it('lists every command for a bare slash, Emoji first', () => {
    const items = slashItems('', label);
    expect(ids(items)).toEqual(SLASH_COMMANDS.map(c => c.id));
    expect(ids(items)[0]).toBe('emoji');
    expect(items.every(item => item.kind === 'command')).toBe(true);
    expect(ids(items)).toEqual(expect.arrayContaining(['bulletList', 'numberedList', 'quote', 'codeBlock', 'divider']));
  });

  it('narrows by what is typed, on the name or a keyword', () => {
    expect(ids(slashItems('bul', label))).toEqual(['bulletList']);
    expect(ids(slashItems('list', label))).toEqual(['bulletList', 'numberedList']);
    expect(ids(slashItems('CODE', label))).toEqual(['codeBlock']);
    expect(ids(slashItems('hr', label))).toEqual(['divider']);          // keyword, not the name
    expect(slashItems('zzzz', label)).toEqual([]);
  });

  it('every command names itself and says what it does through the catalog', () => {
    for (const command of SLASH_COMMANDS) {
      expect(en[command.labelKey], command.labelKey).toBeTruthy();
      expect(en[command.hintKey], command.hintKey).toBeTruthy();
      expect(command.keywords.length).toBeGreaterThan(0);
    }
  });

  it('"emoji " (with the space) switches to emoji, filtered by the rest', () => {
    const popular = slashItems('emoji ', label);
    expect(popular.length).toBeGreaterThan(10);
    expect(popular.length).toBeLessThanOrEqual(30);
    expect(popular.every(item => item.kind === 'emoji' && item.char)).toBe(true);

    const smiles = slashItems('emoji smile', label);
    expect(smiles.map(item => item.char)).toContain('😊');
    expect(smiles.every(item => /smile/.test(`${item.label} ${item.keywords}`))).toBe(true);
    expect(slashItems('emoji qqqqqq', label)).toEqual([]);
  });

  it('finds an emoji straight from /word once the word is long enough and no command matches', () => {
    expect(slashItems('rocket', label).map(item => item.char)).toContain('🚀');
    expect(slashItems('r', label).every(item => item.kind === 'command')).toBe(true);
  });

  it('a command never lists twice, and the same query gives the same answer', () => {
    expect(new Set(ids(slashItems('', label))).size).toBe(SLASH_COMMANDS.length);
    expect(slashItems('emoji smile', label).map(i => i.id)).toEqual(slashItems('emoji smile', label).map(i => i.id));
  });
});
