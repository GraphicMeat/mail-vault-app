// The phone's custom fields (desktop's fields, kept by the engine: `mobile.fields.*`, engine
// `fields.rs`). This is only the render cache, like desktop's fieldStore: each account's fields
// and the values of the rows asked about, keyed `account|folder|uid`. The key a value is stored
// under is the engine's and never computed here.
//
// Every account's fields load once at launch (App.jsx `requestFields` per account; the settings
// page loads its own), and again after every change, so opening a message asks for nothing more
// unless its account has a field: then its values load when the viewer opens it. A value change shows at once and goes back if the engine refuses it.
import { useEffect } from 'react';
import { create } from 'zustand';
import { daemonCall } from './transport.js';
import { rowKey } from './tags.js';

const EMPTY = Object.freeze({});
const NONE = Object.freeze([]);

const item = (r) => ({ accountId: r.accountId, folder: r.folder, uid: r.uid });

export const useFieldStore = create((set, get) => ({
  /** account id -> its fields (the shared ones first). */
  fields: {},
  /** rowKey -> { fieldId: value }, for the rows asked about. */
  byRow: {},

  loadFields: async (accountId) => {
    if (!accountId) return [];
    const reply = await daemonCall('mobile.fields.list', { accountId });
    const list = Array.isArray(reply?.fields) ? reply.fields : [];
    set((state) => ({ fields: { ...state.fields, [accountId]: list } }));
    return list;
  },

  /** Every account whose list holds this field (a shared one is in each). */
  reloadAll: async () => {
    await Promise.all(Object.keys(get().fields).map((id) => get().loadFields(id).catch(() => [])));
  },

  saveField: async (accountId, field) => {
    try {
      const reply = await daemonCall('mobile.fields.save', { field });
      return reply?.field || null;
    } finally {
      // A shared field shows in every account's list; a refused save puts the list back.
      await get().reloadAll();
      if (!get().fields[accountId]) await get().loadFields(accountId).catch(() => []);
    }
  },

  moveField: async (accountId, fieldId, delta) => {
    await daemonCall('mobile.fields.reorder', { id: fieldId, delta });
    await get().reloadAll();
  },

  deleteField: async (accountId, fieldId) => {
    await daemonCall('mobile.fields.delete', { id: fieldId });
    set((state) => ({
      byRow: Object.fromEntries(Object.entries(state.byRow).map(([key, values]) => {
        const { [fieldId]: _gone, ...rest } = values;
        return [key, rest];
      })),
    }));
    await get().reloadAll();
  },

  /** How many messages hold each choice of a field (`{}` when the engine cannot say). */
  optionUsage: async (fieldId) => {
    try {
      const reply = await daemonCall('mobile.fields.optionUsage', { fieldId });
      return reply?.usage && typeof reply.usage === 'object' ? reply.usage : {};
    } catch {
      return {};
    }
  },

  copyFields: async (fieldIds, accountId) => {
    const reply = await daemonCall('mobile.fields.copy', { fieldIds, accountId });
    await get().loadFields(accountId);
    return reply?.fields || [];
  },

  /** Fill the cache for these rows (one call). */
  loadRows: async (rows) => {
    if (!rows.length) return;
    const reply = await daemonCall('mobile.fields.values', { items: rows.map(item) });
    const lists = Array.isArray(reply?.values) ? reply.values : [];
    set((state) => {
      const byRow = { ...state.byRow };
      rows.forEach((r, i) => { byRow[rowKey(r.accountId, r.folder, r.uid)] = lists[i] && typeof lists[i] === 'object' ? lists[i] : EMPTY; });
      return { byRow };
    });
  },

  /** Set or clear one value of a row: shown at once, put back when the engine refuses. */
  setValue: async (row, fieldId, value) => {
    const key = rowKey(row.accountId, row.folder, row.uid);
    const before = get().byRow;
    const cleared = value === null || value === undefined || value === '' || (Array.isArray(value) && !value.length);
    set((state) => {
      const current = { ...(state.byRow[key] || EMPTY) };
      if (cleared) delete current[fieldId];
      else current[fieldId] = value;
      return { byRow: { ...state.byRow, [key]: current } };
    });
    try {
      await daemonCall('mobile.fields.set', { item: item(row), fieldId, value: cleared ? null : value });
      return true;
    } catch {
      set({ byRow: before });
      return false;
    }
  },
}));

// An account's fields are asked for once; a failed load is asked again by the next caller.
const asked = new Set();

/** Ask for an account's fields, unless they are loaded or on their way. */
export function requestFields(accountId) {
  if (!accountId || asked.has(accountId) || useFieldStore.getState().fields[accountId]) return;
  asked.add(accountId);
  useFieldStore.getState().loadFields(accountId).catch(() => {}).finally(() => asked.delete(accountId));
}

/** After an import brought fields: every list known so far asked for again, every value dropped. */
export function refreshFields() {
  const known = Object.keys(useFieldStore.getState().fields);
  useFieldStore.setState({ fields: {}, byRow: {} });
  asked.clear();
  for (const id of known) requestFields(id);
}

/**
 * An open message's fields (`schema`, its account's, as loaded at launch) and its `values`, asked
 * for once the account has a field.
 */
export function useRowFields(accountId, folder, uid) {
  const key = rowKey(accountId, folder, uid);
  const schema = useFieldStore((s) => s.fields[accountId] || NONE);
  const values = useFieldStore((s) => s.byRow[key] || EMPTY);
  const cached = useFieldStore((s) => key in s.byRow);
  const has = schema.length > 0;
  useEffect(() => {
    if (has && !cached && accountId && folder && uid != null) {
      useFieldStore.getState().loadRows([{ accountId, folder, uid }]).catch(() => {});
    }
  }, [has, cached, accountId, folder, uid]);
  return { schema, values };
}

/** Tests: back to a phone that has asked for nothing. */
export function resetFieldsForTests() {
  asked.clear();
  useFieldStore.setState({ fields: {}, byRow: {} });
}
