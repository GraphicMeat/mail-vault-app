import { replyBudget } from './helpers/rustSources.js';
import { expect, it } from 'vitest';
it('gives metadata reads and complete draft IO explicit shell reply budgets', () => {
  expect(Object.fromEntries(['drafts.save', 'drafts.list', 'drafts.discard'].map(method => [method, replyBudget(method)]))).toEqual({ 'drafts.save': 600, 'drafts.list': 120, 'drafts.discard': 120 });
});
