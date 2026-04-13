/**
 * Learning Store — state management for learned rules and correction history.
 */

import { create } from 'zustand';
import * as learningService from '../services/learningService.js';

export const useLearningStore = create((set, get) => ({
  rules: [],
  stats: null,
  loading: false,
  error: null,

  /**
   * Load rules and stats for an account.
   */
  loadRules: async (accountId) => {
    set({ loading: true, error: null });
    try {
      const [rules, stats] = await Promise.all([
        learningService.getRules(accountId),
        learningService.getStats(accountId),
      ]);
      set({ rules, stats, loading: false });
    } catch (e) {
      set({ loading: false, error: e.message });
    }
  },

  /**
   * Record a correction and refresh rules.
   */
  recordCorrection: async (accountId, email, correction) => {
    try {
      const result = await learningService.recordCorrection(accountId, email, correction);
      // Refresh rules if a new one was generated
      if (result.ruleGenerated) {
        await get().loadRules(accountId);
      }
      return result;
    } catch (e) {
      set({ error: e.message });
      return { correctionSaved: false };
    }
  },

  /**
   * Save (add or update) a rule and refresh.
   */
  saveRule: async (accountId, rule) => {
    try {
      await learningService.saveRule(accountId, rule);
      await get().loadRules(accountId);
    } catch (e) {
      set({ error: e.message });
    }
  },

  /**
   * Delete a rule and refresh.
   */
  deleteRule: async (accountId, ruleId) => {
    try {
      await learningService.deleteRule(accountId, ruleId);
      set(state => ({ rules: state.rules.filter(r => r.id !== ruleId) }));
    } catch (e) {
      set({ error: e.message });
    }
  },

  reset: () => set({ rules: [], stats: null, loading: false, error: null }),
}));
