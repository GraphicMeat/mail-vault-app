// @vitest-environment node
// Compose's From choices as pure data: every account with its aliases under it, and the signature
// swap when a compose moves to another account.
import { describe, it, expect } from 'vitest';
import { fromGroups, swapSignature } from '../compose/fromChoices.js';
import { REMIND_CHOICES, remindDurationKey } from '../compose/followUp.js';
import { withSignature } from '../prefs.js';

describe('fromGroups', () => {
  const accounts = [
    { id: 'a1', email: 'ada@example.test', displayName: 'Ada' },
    { id: 'a2', email: 'grace@example.test', displayName: 'Grace' },
  ];

  it('lists every account with its own address first and its aliases after it', () => {
    const groups = fromGroups(accounts, new Map([
      ['a1', { displayName: 'Ada', aliases: [] }],
      ['a2', { displayName: 'Grace', aliases: [{ address: 'g2@example.test', name: 'Grace Two' }] }],
    ]));
    expect(groups.map((g) => g.account.id)).toEqual(['a1', 'a2']);
    expect(groups[0].identities.map((i) => i.address)).toEqual(['ada@example.test']);
    expect(groups[1].identities.map((i) => i.address)).toEqual(['grace@example.test', 'g2@example.test']);
    expect(groups[1].identities[1].label).toBe('Grace Two <g2@example.test>');
  });

  it('an account whose settings are not loaded yet shows just its own address', () => {
    const groups = fromGroups(accounts, new Map());
    expect(groups.map((g) => g.identities.map((i) => i.address))).toEqual([['ada@example.test'], ['grace@example.test']]);
  });
});

describe('swapSignature', () => {
  const ada = withSignature('', 'Ada sig');
  const grace = withSignature('', 'Grace sig');

  it('puts the new account\'s signature where the old one stood, keeping what was typed', () => {
    expect(swapSignature(`Hello there${ada}`, ada, grace)).toBe(`Hello there${grace}`);
  });

  it('keeps a quote below it', () => {
    expect(swapSignature(`Hi${ada}\n\n> quoted`, ada, grace)).toBe(`Hi${grace}\n\n> quoted`);
  });

  it('drops the old signature when the new account has none', () => {
    expect(swapSignature(`Hello${ada}`, ada, '')).toBe('Hello');
  });

  it('adds the new signature above the quote when the old account had none', () => {
    expect(swapSignature('Hi\n\n> quoted', '', grace, { quote: '> quoted' })).toBe(`Hi${grace}\n\n> quoted`);
    expect(swapSignature('Hi', '', grace)).toBe(`Hi${grace}`);
  });

  it('leaves text alone when the user already removed the old signature, or added nothing to add', () => {
    expect(swapSignature('Hello', ada, grace)).toBe('Hello');
    expect(swapSignature('Hello', '', '')).toBe('Hello');
    expect(swapSignature(`Hello${grace}`, '', grace)).toBe(`Hello${grace}`);
  });

  it('replaces the last copy, the one the screen added', () => {
    expect(swapSignature(`${ada} quoted above\nBody${ada}`, ada, grace)).toBe(`${ada} quoted above\nBody${grace}`);
  });
});

describe('follow-up choices', () => {
  it('are Off, 1 day, 3 days and 1 week, the chip naming its duration', () => {
    expect(REMIND_CHOICES.map(([days]) => days)).toEqual([0, 1, 3, 7]);
    expect(remindDurationKey(3)).toBe('compose.remind.days3');
    expect(remindDurationKey(7)).toBe('compose.remind.days7');
    expect(remindDurationKey(2)).toBeNull();
  });
});
